import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, Source, SourceDocumentStatus, SourceProvider } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PageFetcherService, PageFetchError } from './page-fetcher.service';
import { htmlToReadableText } from './html-to-text.util';
import { SOURCE_DOCUMENT_STORAGE, SourceDocumentStorage } from './source-document-storage.interface';

// Below this, trust the extraction failed (nav-only shell, paywall
// interstitial, cookie-consent page) rather than persist near-nothing as
// if it were the article.
const MIN_EXTRACTED_TEXT_LENGTH = 200;

export interface SourceDocumentOutcome {
  sourceId: string;
  status: SourceDocumentStatus;
}

/**
 * Full-text retrieval + extraction for one Source, per the locked
 * Slice 2 rules:
 *
 *  - Web (Tavily-discovered) sources: re-fetch the canonical URL
 *    ourselves and extract readable text. Tavily's snippet (stored on
 *    Source.abstract) is discovery metadata only and is never promoted
 *    to full text, and — per the doc's specific "usable academic
 *    abstract" wording for ABSTRACT_ONLY — a web source whose fetch
 *    fails goes to FAILED, not ABSTRACT_ONLY, even when a Tavily
 *    snippet exists. This is a real scoping choice, not an oversight:
 *    flag it if product wants web sources to fall back to their
 *    snippet later.
 *  - Academic (Semantic-Scholar-discovered) sources: attempt the
 *    open-access PDF/HTML link when Semantic Scholar provided one (see
 *    SemanticScholarProvider, which stores it in Source.metadata.
 *    openAccessPdfUrl). PDF text extraction is out of scope for this
 *    slice (no PDF parser dependency yet) — a PDF (or otherwise
 *    non-HTML) open-access link falls back to ABSTRACT_ONLY rather than
 *    pretending to extract it.
 *  - No reachable link at all: ABSTRACT_ONLY if Source.abstract exists,
 *    otherwise FAILED.
 *
 * A FAILED source is never discarded — only the SourceDocument records
 * the failure; the Source row and its metadata stay intact.
 */
@Injectable()
export class SourceDocumentService {
  private readonly logger = new Logger(SourceDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pageFetcher: PageFetcherService,
    @Inject(SOURCE_DOCUMENT_STORAGE) private readonly storage: SourceDocumentStorage,
  ) {}

  async retrieveForSource(source: Source): Promise<SourceDocumentOutcome> {
    try {
      if (source.provider === SourceProvider.SEMANTIC_SCHOLAR) {
        return await this.retrieveAcademic(source);
      }
      return await this.retrieveWeb(source);
    } catch (error) {
      // Defensive: retrieveWeb/retrieveAcademic already catch fetch
      // failures internally. This only fires on something unexpected
      // (e.g. a storage write failure) — still resolves to a FAILED
      // SourceDocument rather than blowing up the whole research run.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unexpected error retrieving source ${source.id}: ${message}`);
      return this.recordFailure(source, null, `Unexpected retrieval error: ${message}`);
    }
  }

  /** Deletes any stored text for the given Source ids. Safe to call for ids that never had text stored. */
  async cleanupOrphanedText(sourceIds: string[]): Promise<void> {
    await Promise.all(sourceIds.map((id) => this.storage.delete(id)));
  }

  /**
   * Reads back the full text stored for a COMPLETED source. Returns null
   * if nothing was ever stored (e.g. the source is ABSTRACT_ONLY/FAILED,
   * or retrieval simply hasn't run) — callers must not assume a non-null
   * result just because a source exists.
   */
  async getStoredText(sourceId: string): Promise<string | null> {
    return this.storage.retrieve(sourceId);
  }

  private async retrieveWeb(source: Source): Promise<SourceDocumentOutcome> {
    if (!source.url) {
      return this.recordFailure(source, null, 'No URL was discovered for this web source.');
    }
    return this.attemptFetchAndExtract(source, source.url, false);
  }

  private async retrieveAcademic(source: Source): Promise<SourceDocumentOutcome> {
    const openAccessPdfUrl = this.readOpenAccessPdfUrl(source.metadata);

    if (openAccessPdfUrl) {
      return this.attemptFetchAndExtract(source, openAccessPdfUrl, true, {
        onUnsupportedContentType:
          'An open-access link exists but is not HTML (likely a PDF) — PDF text extraction is not implemented in this slice.',
      });
    }

    if (source.abstract) {
      return this.recordAbstractOnly(
        source,
        null,
        'No reachable open-access full text; usable abstract stored instead.',
      );
    }

    return this.recordFailure(source, null, 'No open-access link and no abstract available for this academic source.');
  }

  private async attemptFetchAndExtract(
    source: Source,
    url: string,
    allowAbstractFallback: boolean,
    opts?: { onUnsupportedContentType?: string },
  ): Promise<SourceDocumentOutcome> {
    try {
      const page = await this.pageFetcher.fetch(url);
      const text = htmlToReadableText(page.body);

      if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
        return this.fallbackOrFail(
          source,
          page.finalUrl,
          `Fetched ${page.finalUrl} but extracted only ${text.length} usable characters — treating as an extraction failure.`,
          allowAbstractFallback,
          page.httpStatus,
        );
      }

      await this.storage.store(source.id, text);
      await this.upsertDocumentRow(source, {
        status: SourceDocumentStatus.COMPLETED,
        retrievedUrl: page.finalUrl,
        httpStatus: page.httpStatus,
        mimeType: page.contentType,
        fileSize: page.byteSize,
        checksum: sha256(text),
        textStorageKey: source.id,
        extractedAt: new Date(),
        errorMessage: null,
      });

      return { sourceId: source.id, status: SourceDocumentStatus.COMPLETED };
    } catch (error) {
      const message =
        error instanceof PageFetchError
          ? error.reason === 'unsupported_content_type' && opts?.onUnsupportedContentType
            ? opts.onUnsupportedContentType
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);
      // PageFetchError doesn't carry a structured status for non-2xx
      // responses (it's folded into the message) — nothing to pass here.
      return this.fallbackOrFail(source, url, message, allowAbstractFallback);
    }
  }

  private async fallbackOrFail(
    source: Source,
    attemptedUrl: string | null,
    errorMessage: string,
    allowAbstractFallback: boolean,
    httpStatus?: number,
  ): Promise<SourceDocumentOutcome> {
    if (allowAbstractFallback && source.abstract) {
      return this.recordAbstractOnly(source, attemptedUrl, errorMessage, httpStatus);
    }
    return this.recordFailure(source, attemptedUrl, errorMessage, httpStatus);
  }

  private async recordAbstractOnly(
    source: Source,
    attemptedUrl: string | null,
    errorMessage: string,
    httpStatus?: number,
  ): Promise<SourceDocumentOutcome> {
    await this.upsertDocumentRow(source, {
      status: SourceDocumentStatus.ABSTRACT_ONLY,
      retrievedUrl: attemptedUrl,
      httpStatus: httpStatus ?? null,
      errorMessage,
    });
    return { sourceId: source.id, status: SourceDocumentStatus.ABSTRACT_ONLY };
  }

  private async recordFailure(
    source: Source,
    attemptedUrl: string | null,
    errorMessage: string,
    httpStatus?: number,
  ): Promise<SourceDocumentOutcome> {
    await this.upsertDocumentRow(source, {
      status: SourceDocumentStatus.FAILED,
      retrievedUrl: attemptedUrl,
      httpStatus: httpStatus ?? null,
      errorMessage,
    });
    return { sourceId: source.id, status: SourceDocumentStatus.FAILED };
  }

  private async upsertDocumentRow(
    source: Source,
    data: Omit<Prisma.SourceDocumentUncheckedCreateInput, 'sourceId'>,
  ) {
    return this.prisma.sourceDocument.upsert({
      where: { sourceId: source.id },
      create: { sourceId: source.id, ...data },
      update: data,
    });
  }

  private readOpenAccessPdfUrl(metadata: Prisma.JsonValue | null): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>).openAccessPdfUrl;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
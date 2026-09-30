import { Injectable, Logger } from '@nestjs/common';
import { SourceType } from '@prisma/client';
import {
  DiscoveryQuery,
  SearchProvider,
  SourceCandidate,
} from '../search-provider.interface';
import { fetchWithRetry } from '../../http/retry';

interface SemanticScholarAuthor {
  name: string;
}

interface SemanticScholarPaper {
  title: string;
  abstract: string | null;
  year: number | null;
  venue: string | null;
  url: string | null;
  authors: SemanticScholarAuthor[];
  externalIds?: { DOI?: string };
  openAccessPdf?: { url: string | null; status: string | null } | null;
}

interface SemanticScholarResponse {
  data: SemanticScholarPaper[];
}

// Slice 2 addition: `openAccessPdf` so full-text retrieval has something
// to try beyond the abstract. See SourceDocumentService.retrieveAcademic
// — a link here is only ever *attempted*, never trusted as full text
// until it's actually fetched and extracted.
const FIELDS =
  'title,abstract,year,venue,url,authors,externalIds,openAccessPdf';

/**
 * Academic discovery only. General/professional/government sources go
 * through TavilySearchProvider instead — this provider should not grow
 * general-web fallback logic.
 */
@Injectable()
export class SemanticScholarProvider implements SearchProvider {
  readonly name = 'semantic_scholar' as const;
  private readonly logger = new Logger(SemanticScholarProvider.name);
  private readonly apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;

  async discover(query: DiscoveryQuery): Promise<SourceCandidate[]> {
    const searchQuery = buildQueryString(query);
    const limit = query.maxResults ?? 10;
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
    url.searchParams.set('query', searchQuery);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', FIELDS);

    // Semantic Scholar's unauthenticated pool is shared across every
    // caller of the API worldwide and 429s easily even under light use;
    // an API key raises the limit but doesn't eliminate bursts. Retry
    // through that (and any 5xx) before giving up — a single transient
    // 429 should not silently zero out academic discovery for a run.
    const response = await fetchWithRetry(
      url.toString(),
      { headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined },
      {
        maxAttempts: 3,
        baseDelayMs: 3000,
        maxDelayMs: 15000,
        timeoutMs: 20000,
        onRetry: ({ attempt, delayMs, reason }) =>
          this.logger.warn(
            `Semantic Scholar call failed (${reason}); retry ${attempt} of 2 in ${Math.round(delayMs / 1000)}s`,
          ),
      },
    );

    if (response.status === 429) {
      // Still rate-limited after retrying — degrade gracefully rather
      // than fail the whole research run over one provider.
      this.logger.warn('Semantic Scholar still rate-limited after retrying; returning no academic candidates for this query.');
      return [];
    }

    if (!response.ok) {
      throw new Error(
        `Semantic Scholar search failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as SemanticScholarResponse;

    return (body.data ?? [])
      .filter((paper) => paper.title)
      .map((paper, index) => {
        // Only carry the link forward when Semantic Scholar reports it's
        // actually open-access-available — its own `status` field
        // distinguishes "we have a free copy" from other states (e.g.
        // green/gold OA) that don't guarantee a fetchable PDF.
        const openAccessPdfUrl =
          paper.openAccessPdf?.status && paper.openAccessPdf.url ? paper.openAccessPdf.url : undefined;

        return {
          provider: 'semantic_scholar' as const,
          title: paper.title,
          url: paper.url ?? undefined,
          doi: paper.externalIds?.DOI,
          authors: paper.authors?.map((a) => ({ name: a.name })) ?? [],
          publicationDate: paper.year
            ? new Date(Date.UTC(paper.year, 0, 1))
            : undefined,
          journal: paper.venue ?? undefined,
          abstract: paper.abstract ?? undefined,
          sourceType: SourceType.JOURNAL_ARTICLE,
          // Semantic Scholar doesn't return an explicit relevance score;
          // approximate one from result rank so downstream evaluation has
          // something to sort on, decaying toward 0 across the page.
          relevanceScore: Math.max(0, 1 - index / Math.max(limit, 1)),
          metadata: openAccessPdfUrl ? { openAccessPdfUrl } : undefined,
        };
      });
  }
}

function buildQueryString(query: DiscoveryQuery): string {
  const parts = [query.query, ...(query.keywords ?? [])];
  return parts.filter(Boolean).join(' ');
}
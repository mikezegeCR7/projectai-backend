import { Injectable, Logger } from '@nestjs/common';
import { TavilySearchProvider } from './providers/tavily.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { DiscoveryQuery, SourceCandidate } from './search-provider.interface';

/**
 * The pipeline (ResearchRunProcessor) calls only this — it never knows
 * Tavily or Semantic Scholar exist. Swapping/adding a provider means
 * changing this file and the providers/ dir, nothing in research-runs/.
 */
@Injectable()
export class SearchGatewayService {
  private readonly logger = new Logger(SearchGatewayService.name);

  constructor(
    private readonly tavily: TavilySearchProvider,
    private readonly semanticScholar: SemanticScholarProvider,
  ) {}

  async discover(query: DiscoveryQuery): Promise<SourceCandidate[]> {
    // Always query both — PRD.md §4 wants both academic and professional
    // outputs supported, and a single project may need both kinds of
    // source. Evaluation (not discovery) is where relevance gets sorted
    // out per RESEARCH-INTELLIGENCE.md §4 ("Discovery is not the same as
    // verification").
    const [tavilyResult, semanticScholarResult] = await Promise.allSettled([
      this.tavily.discover(query),
      this.semanticScholar.discover(query),
    ]);

    const candidates: SourceCandidate[] = [];

    if (tavilyResult.status === 'fulfilled') {
      candidates.push(...tavilyResult.value);
    } else {
      this.logger.warn(`Tavily discovery failed: ${tavilyResult.reason}`);
    }

    if (semanticScholarResult.status === 'fulfilled') {
      candidates.push(...semanticScholarResult.value);
    } else {
      this.logger.warn(
        `Semantic Scholar discovery failed: ${semanticScholarResult.reason}`,
      );
    }

    return dedupe(candidates);
  }
}

/**
 * Dedupes by DOI first (strongest identity), then by normalized URL, then
 * by normalized title as a last resort (two providers can surface the
 * same paper with slightly different titles/whitespace/casing).
 */
function dedupe(candidates: SourceCandidate[]): SourceCandidate[] {
  const seenDoi = new Set<string>();
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const result: SourceCandidate[] = [];

  for (const candidate of candidates) {
    const doiKey = candidate.doi?.trim().toLowerCase();
    if (doiKey) {
      if (seenDoi.has(doiKey)) continue;
      seenDoi.add(doiKey);
    }

    const urlKey = candidate.url ? normalizeUrl(candidate.url) : undefined;
    if (urlKey) {
      if (seenUrl.has(urlKey)) continue;
      seenUrl.add(urlKey);
    }

    const titleKey = normalizeTitle(candidate.title);
    if (!urlKey && !doiKey && seenTitle.has(titleKey)) continue;
    seenTitle.add(titleKey);

    result.push(candidate);
  }

  return result;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

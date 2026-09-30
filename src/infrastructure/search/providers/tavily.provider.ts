import { Injectable, Logger } from '@nestjs/common';
import { SourceType } from '@prisma/client';
import {
  DiscoveryQuery,
  SearchProvider,
  SourceCandidate,
} from '../search-provider.interface';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

/**
 * General web / professional / government / news discovery. Deliberately
 * NOT used for academic search — Semantic Scholar covers that — so this
 * provider is not the place to add scholarly-source heuristics.
 */
@Injectable()
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily' as const;
  private readonly logger = new Logger(TavilySearchProvider.name);
  private readonly apiKey = process.env.TAVILY_API_KEY;

  async discover(query: DiscoveryQuery): Promise<SourceCandidate[]> {
    if (!this.apiKey) {
      this.logger.warn(
        'TAVILY_API_KEY is not set — skipping Tavily discovery.',
      );
      return [];
    }

    const searchQuery = buildQueryString(query);

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: searchQuery,
        search_depth: 'advanced',
        max_results: query.maxResults ?? 10,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Tavily search failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as TavilyResponse;

    return (body.results ?? []).map((result) => ({
      provider: 'tavily' as const,
      title: result.title,
      url: result.url,
      abstract: truncate(result.content, 2000),
      sourceType: inferSourceType(result.url),
      relevanceScore: clamp01(result.score),
      publicationDate: result.published_date
        ? safeDate(result.published_date)
        : undefined,
      metadata: { rawScore: result.score },
    }));
  }
}

function buildQueryString(query: DiscoveryQuery): string {
  const parts = [query.query, ...(query.keywords ?? [])];
  if (query.geographicFocus) parts.push(query.geographicFocus);
  return parts.filter(Boolean).join(' ');
}

/**
 * Coarse, best-effort classification from the domain. This is a heuristic
 * placeholder for real Source Evaluation (RESEARCH-INTELLIGENCE.md §5),
 * which is out of scope for this slice — it only affects the `sourceType`
 * label stored, not whether a source is accepted.
 */
function inferSourceType(url: string): SourceType {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.gov') || host.includes('.gov.'))
      return SourceType.GOVERNMENT_REPORT;
    if (host.endsWith('.edu')) return SourceType.OFFICIAL_DOCUMENT;
    if (/news|reuters|bbc|nytimes|apnews/i.test(host)) return SourceType.NEWS;
    return SourceType.WEBSITE;
  } catch {
    return SourceType.OTHER;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function safeDate(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

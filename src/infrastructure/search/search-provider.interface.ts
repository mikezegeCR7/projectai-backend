import { SourceType } from '@prisma/client';

/**
 * What every provider adapter must produce. Nothing downstream of the
 * Search Gateway (evaluation, dedup, persistence) ever sees a
 * Tavily/Semantic-Scholar-shaped object — this is the contract from
 * TRD.md §6 ("Search Gateway abstraction... not tightly coupled to a
 * single provider").
 */
export interface SourceCandidate {
  provider: 'tavily' | 'semantic_scholar';
  title: string;
  url?: string;
  doi?: string;
  authors?: { name: string }[];
  publicationDate?: Date;
  publisher?: string;
  journal?: string;
  abstract?: string;
  sourceType: SourceType;
  /** Provider-native relevance signal, normalized to 0-1 where possible. Not comparable across providers as a precise score — used as a coarse evaluation input only. */
  relevanceScore?: number;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveryQuery {
  /** The core question or topic — always sent to both providers. */
  query: string;
  /** Additional keywords to broaden/focus the query. */
  keywords?: string[];
  geographicFocus?: string;
  /** ISO date strings, inclusive. */
  dateFrom?: string;
  dateTo?: string;
  maxResults?: number;
}

export interface SearchProvider {
  readonly name: SourceCandidate['provider'];
  discover(query: DiscoveryQuery): Promise<SourceCandidate[]>;
}

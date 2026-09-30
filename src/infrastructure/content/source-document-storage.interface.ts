/**
 * Storage abstraction for extracted source full text. Per the locked
 * Slice 2 decision: Slice 2 stores text in PostgreSQL (see
 * PostgresTextStorage), but nothing outside this file's contract should
 * know that. Moving to S3/object storage later means adding a new
 * implementation of this interface and swapping the provider binding in
 * ContentModule — SourceDocumentService and the research pipeline never
 * change.
 *
 * Keys are opaque strings. By convention the Postgres implementation
 * uses the owning Source's id as the key (see SourceDocumentService),
 * but callers must not assume anything about key format.
 */
export interface SourceDocumentStorage {
  readonly kind: 'postgres' | 'object_storage';
  store(key: string, text: string): Promise<void>;
  retrieve(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export const SOURCE_DOCUMENT_STORAGE = Symbol('SOURCE_DOCUMENT_STORAGE');
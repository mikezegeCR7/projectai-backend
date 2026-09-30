import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SourceDocumentStorage } from './source-document-storage.interface';

/**
 * Slice 2's SourceDocumentStorage implementation. Backed by the
 * SourceDocumentText table, which is deliberately not foreign-keyed to
 * SourceDocument — see schema.prisma header note 7 for why, and for the
 * known cleanup limitation this implies.
 */
@Injectable()
export class PostgresTextStorage implements SourceDocumentStorage {
  readonly kind = 'postgres' as const;

  constructor(private readonly prisma: PrismaService) {}

  async store(key: string, text: string): Promise<void> {
    await this.prisma.sourceDocumentText.upsert({
      where: { key },
      create: { key, content: text },
      update: { content: text },
    });
  }

  async retrieve(key: string): Promise<string | null> {
    const row = await this.prisma.sourceDocumentText.findUnique({ where: { key } });
    return row?.content ?? null;
  }

  async delete(key: string): Promise<void> {
    // deleteMany (not delete) so this is safe to call for a key that was
    // never written — e.g. cleaning up a source that failed before any
    // text was ever stored.
    await this.prisma.sourceDocumentText.deleteMany({ where: { key } });
  }
}
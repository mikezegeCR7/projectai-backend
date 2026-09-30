import { Module } from '@nestjs/common';
import { PageFetcherService } from './page-fetcher.service';
import { PostgresTextStorage } from './postgres-text-storage.service';
import { SOURCE_DOCUMENT_STORAGE } from './source-document-storage.interface';
import { SourceDocumentService } from './source-document.service';

// PrismaModule is @Global (see infrastructure/database/prisma.module.ts)
// so PrismaService is already available here without an explicit
// import.
//
// The SOURCE_DOCUMENT_STORAGE binding is the one line that changes when
// Slice 2's Postgres text storage is later replaced with S3/object
// storage — everything else in this module, and everything that
// consumes SourceDocumentService, stays the same.
@Module({
  providers: [
    PageFetcherService,
    PostgresTextStorage,
    { provide: SOURCE_DOCUMENT_STORAGE, useExisting: PostgresTextStorage },
    SourceDocumentService,
  ],
  exports: [SourceDocumentService],
})
export class ContentModule {}
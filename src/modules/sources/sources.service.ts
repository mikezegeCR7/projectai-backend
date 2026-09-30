import { Injectable } from '@nestjs/common';
import { Source, SourceDocument } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

// Slice 2 addition: both methods now include the related SourceDocument
// (full-text retrieval status) so the frontend can show retrieval state
// without a new endpoint. Not a new contract, just extending the
// existing Source response shape.
type SourceWithDocument = Source & { document: SourceDocument | null };

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProject(projectId: string): Promise<SourceWithDocument[]> {
    return this.prisma.source.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { document: true },
    });
  }

  async getOwned(userId: string, sourceId: string): Promise<SourceWithDocument> {
    const source = await this.prisma.source.findUnique({
      where: { id: sourceId },
      include: { project: { select: { ownerId: true } }, document: true },
    });
    if (!source || source.project.ownerId !== userId) {
      throw new AppError(ErrorCode.SOURCE_NOT_FOUND, 'Source not found.');
    }
    return source;
  }
}
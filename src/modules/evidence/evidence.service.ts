import { Injectable } from '@nestjs/common';
import { Evidence } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProject(projectId: string): Promise<Evidence[]> {
    return this.prisma.evidence.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOwned(userId: string, evidenceId: string): Promise<Evidence> {
    const evidence = await this.prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { project: { select: { ownerId: true } } },
    });
    if (!evidence || evidence.project.ownerId !== userId) {
      throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND, 'Evidence not found.');
    }
    return evidence;
  }
}
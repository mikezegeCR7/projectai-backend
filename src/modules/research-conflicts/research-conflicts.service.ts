import { Injectable } from '@nestjs/common';
import { ConflictEvidence, ResearchConflict } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type ConflictWithEvidence = ResearchConflict & { evidence: ConflictEvidence[] };

/**
 * Read-only. Detecting that two credible sources genuinely disagree
 * (RESEARCH-INTELLIGENCE.md §9) requires comparing evidence meaning, not
 * just surface text — a heuristic here risks flagging false conflicts,
 * which is its own kind of research-integrity failure. Written only by
 * the Research Analyst role during a research run
 * (ResearchRunProcessor.buildKnowledge).
 *
 * Each conflict is returned with its ConflictEvidence links (which Evidence
 * rows it is between), per DATABASE.md sec. 20 "preserve the relevant
 * claims/evidence". Extends the existing response shape; no new endpoint.
 */
@Injectable()
export class ResearchConflictsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProject(projectId: string): Promise<ConflictWithEvidence[]> {
    return this.prisma.researchConflict.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { evidence: true },
    });
  }
}
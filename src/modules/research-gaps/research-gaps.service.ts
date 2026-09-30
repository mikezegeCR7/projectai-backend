import { Injectable } from '@nestjs/common';
import { ResearchGap } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Read-only. A genuine research gap ("limited evidence found" vs "no
 * research exists" — RESEARCH-INTELLIGENCE.md §10) requires judgement
 * over the full evidence set; written only by the Research Analyst role during a
 * research run (ResearchRunProcessor.buildKnowledge).
 */
@Injectable()
export class ResearchGapsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProject(projectId: string): Promise<ResearchGap[]> {
    return this.prisma.researchGap.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
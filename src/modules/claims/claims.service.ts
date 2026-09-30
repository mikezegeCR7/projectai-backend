import { Injectable } from '@nestjs/common';
import { Claim, ClaimEvidence } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

// Both methods include the claim's ClaimEvidence links so the frontend can
// show which Evidence a claim's status actually rests on. Extends the
// existing response shape; no new endpoint.
type ClaimWithEvidence = Claim & { evidence: ClaimEvidence[] };

/**
 * Still read-only over HTTP: Claims are written only by the Research Analyst role
 * during a research run (see ResearchRunProcessor.buildKnowledge), never
 * directly by a client. A Claim's status only means something if it comes
 * from real reasoning over real Evidence, so there is deliberately no
 * POST/PUT here (API.md defines only GET routes for claims). A project whose runs produced no usable Evidence will
 * legitimately have no Claims.
 */
@Injectable()
export class ClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProject(projectId: string): Promise<ClaimWithEvidence[]> {
    return this.prisma.claim.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { evidence: true },
    });
  }

  async getOwned(userId: string, claimId: string): Promise<ClaimWithEvidence> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { project: { select: { ownerId: true } }, evidence: true },
    });
    if (!claim || claim.project.ownerId !== userId) {
      throw new AppError(ErrorCode.CLAIM_NOT_FOUND, 'Claim not found.');
    }
    return claim;
  }
}
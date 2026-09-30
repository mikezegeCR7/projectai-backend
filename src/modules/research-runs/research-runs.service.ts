import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ResearchRun, ResearchRunEvent } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateResearchRunDto } from './dto/create-research-run.dto';
import {
  RESEARCH_QUEUE_NAME,
  RUN_RESEARCH_JOB_NAME,
  RunResearchJobData,
} from '../../infrastructure/queue/queue.constants';

const CANCELLABLE_STATUSES = ['QUEUED', 'RUNNING'] as const;

@Injectable()
export class ResearchRunsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(RESEARCH_QUEUE_NAME)
    private readonly researchQueue: Queue<RunResearchJobData>,
  ) {}

  async create(
    projectId: string,
    dto: CreateResearchRunDto,
  ): Promise<ResearchRun> {
    const plan = await this.prisma.researchPlan.findUnique({
      where: { id: dto.researchPlanId },
    });
    if (!plan || plan.projectId !== projectId) {
      throw new AppError(
        ErrorCode.RESEARCH_PLAN_NOT_FOUND,
        'Research plan not found for this project.',
      );
    }
    const keywords = Array.isArray(plan.keywords) ? plan.keywords : [];
    if (!plan.mainQuestion && keywords.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Research plan needs a mainQuestion or at least one keyword before a run can be started.',
      );
    }

    const run = await this.prisma.researchRun.create({
      data: {
        projectId,
        researchPlanId: plan.id,
        status: 'QUEUED',
      },
    });

    await this.prisma.researchRunEvent.create({
      data: {
        researchRunId: run.id,
        type: 'queued',
        message: 'Research run queued.',
      },
    });

    // Job id = run id makes re-POSTing impossible to double-enqueue by
    // accident and gives BullMQ a stable handle matching our own record.
    await this.researchQueue.add(
      RUN_RESEARCH_JOB_NAME,
      { researchRunId: run.id },
      { jobId: run.id },
    );

    return run;
  }

  /** Ownership choke point for research-runs/:id routes. */
  async getOwned(userId: string, researchRunId: string): Promise<ResearchRun> {
    const run = await this.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      include: { project: { select: { ownerId: true } } },
    });
    if (!run || run.project.ownerId !== userId) {
      throw new AppError(
        ErrorCode.RESEARCH_RUN_NOT_FOUND,
        'Research run not found.',
      );
    }
    return run;
  }

  async listEvents(
    userId: string,
    researchRunId: string,
  ): Promise<ResearchRunEvent[]> {
    await this.getOwned(userId, researchRunId);
    return this.prisma.researchRunEvent.findMany({
      where: { researchRunId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async cancel(userId: string, researchRunId: string): Promise<ResearchRun> {
    const run = await this.getOwned(userId, researchRunId);
    if (!CANCELLABLE_STATUSES.includes(run.status as (typeof CANCELLABLE_STATUSES)[number])) {
      throw new AppError(
        ErrorCode.RESEARCH_RUN_NOT_CANCELLABLE,
        `Cannot cancel a research run with status ${run.status}.`,
      );
    }

    const updated = await this.prisma.researchRun.update({
      where: { id: researchRunId },
      data: { status: 'CANCELLED' },
    });
    await this.prisma.researchRunEvent.create({
      data: {
        researchRunId,
        type: 'cancelled',
        message: 'Research run cancelled by user.',
      },
    });
    // Best-effort: the processor also checks run.status at each stage
    // boundary and bails out if it sees CANCELLED (see
    // research-run.processor.ts) — that's how an in-flight job actually
    // stops, since BullMQ doesn't support killing a running job outright.
    return updated;
  }
}

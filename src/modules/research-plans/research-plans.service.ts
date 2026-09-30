import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ResearchPlan } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateResearchPlanDto } from './dto/create-research-plan.dto';
import { UpdateResearchPlanDto } from './dto/update-research-plan.dto';
import { RequirementsService } from '../requirements/requirements.service';
import { AiGatewayService } from '../../infrastructure/ai/ai-gateway.service';

@Injectable()
export class ResearchPlansService {
  private readonly logger = new Logger(ResearchPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requirementsService: RequirementsService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  async create(
    projectId: string,
    dto: CreateResearchPlanDto,
  ): Promise<ResearchPlan> {
    const latest = await this.prisma.researchPlan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return this.prisma.researchPlan.create({
      data: {
        projectId,
        version: (latest?.version ?? 0) + 1,
        status: 'DRAFT',
        mainQuestion: dto.mainQuestion,
        subQuestions: toJson(dto.subQuestions),
        keywords: toJson(dto.keywords),
        searchConcepts: toJson(dto.searchConcepts),
        sourceTypes: toJson(dto.sourceTypes),
        inclusionCriteria: toJson(dto.inclusionCriteria),
        exclusionCriteria: toJson(dto.exclusionCriteria),
        geographicConstraints: toJson(dto.geographicConstraints),
        dateConstraints: toJson(dto.dateConstraints),
        evidenceCategories: toJson(dto.evidenceCategories),
      },
    });
  }

  /**
   * The Planner role, wired up. Fetches the saved Research Brief
   * (ProjectRequirement — REQUIREMENTS_NOT_FOUND if none saved yet), asks
   * the AI Gateway for a plan, and persists it through the same
   * versioned `create` path as a manually-entered plan — so a
   * generated plan is just version N, editable afterward via the normal
   * PATCH endpoint like any other plan.
   */
  async generate(projectId: string): Promise<ResearchPlan> {
    const requirement = await this.requirementsService.get(projectId);

    let plannerOutput;
    try {
      plannerOutput = await this.aiGateway.planResearch({
        topic: requirement.topic,
        researchArea: requirement.researchArea,
        population: requirement.population,
        geographicFocus: requirement.geographicFocus,
        academicLevel: requirement.academicLevel,
        discipline: requirement.discipline,
        deliverableType: requirement.deliverableType,
        citationStyle: requirement.citationStyle,
        wordCount: requirement.wordCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Planner generation failed for project ${projectId}: ${message}`);
      throw new AppError(
        ErrorCode.AI_GENERATION_FAILED,
        'Could not generate a research plan right now. Try again, or create one manually.',
      );
    }

    return this.create(projectId, {
      mainQuestion: plannerOutput.mainQuestion,
      subQuestions: plannerOutput.subQuestions,
      keywords: plannerOutput.keywords,
      searchConcepts: plannerOutput.searchConcepts,
      sourceTypes: plannerOutput.sourceTypes,
      inclusionCriteria: plannerOutput.inclusionCriteria,
      exclusionCriteria: plannerOutput.exclusionCriteria,
      evidenceCategories: plannerOutput.evidenceCategories,
    });
  }

  /**
   * Ownership choke point for research-plans/:id routes, which aren't
   * nested under /projects/:projectId — mirrors ProjectsService.getOwned.
   */
  async getOwned(userId: string, researchPlanId: string): Promise<ResearchPlan> {
    const plan = await this.prisma.researchPlan.findUnique({
      where: { id: researchPlanId },
      include: { project: { select: { ownerId: true } } },
    });
    if (!plan || plan.project.ownerId !== userId) {
      throw new AppError(
        ErrorCode.RESEARCH_PLAN_NOT_FOUND,
        'Research plan not found.',
      );
    }
    return plan;
  }

  async update(
    userId: string,
    researchPlanId: string,
    dto: UpdateResearchPlanDto,
  ): Promise<ResearchPlan> {
    await this.getOwned(userId, researchPlanId);
    return this.prisma.researchPlan.update({
      where: { id: researchPlanId },
      data: {
        status: dto.status,
        mainQuestion: dto.mainQuestion,
        subQuestions: toJson(dto.subQuestions),
        keywords: toJson(dto.keywords),
        searchConcepts: toJson(dto.searchConcepts),
        sourceTypes: toJson(dto.sourceTypes),
        inclusionCriteria: toJson(dto.inclusionCriteria),
        exclusionCriteria: toJson(dto.exclusionCriteria),
        geographicConstraints: toJson(dto.geographicConstraints),
        dateConstraints: toJson(dto.dateConstraints),
        evidenceCategories: toJson(dto.evidenceCategories),
      },
    });
  }
}

function toJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}
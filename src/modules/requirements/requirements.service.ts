import { Injectable } from '@nestjs/common';
import { ProjectRequirement, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { SaveRequirementsDto } from './dto/save-requirements.dto';

@Injectable()
export class RequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * PUT semantics: save is idempotent and works whether or not a
   * ProjectRequirement row already exists yet (PRD.md §5 — the brief is
   * filled in incrementally, not created once). `version` is bumped on
   * every update after the first so later slices (e.g. re-running research
   * planning) can detect that the brief changed underneath them.
   */
  async save(
    projectId: string,
    dto: SaveRequirementsDto,
  ): Promise<ProjectRequirement> {
    const data: Prisma.ProjectRequirementUncheckedCreateInput = {
      projectId,
      topic: dto.topic,
      researchQuestions: toJson(dto.researchQuestions),
      researchArea: dto.researchArea,
      population: dto.population,
      geographicFocus: dto.geographicFocus,
      academicLevel: dto.academicLevel,
      discipline: dto.discipline,
      deliverableType: dto.deliverableType,
      citationStyle: dto.citationStyle,
      wordCount: dto.wordCount,
      pageCount: dto.pageCount,
      deadline: dto.deadline,
      institution: dto.institution,
      department: dto.department,
      researchStartDate: dto.researchStartDate,
      researchEndDate: dto.researchEndDate,
      additionalRequirements: toJson(dto.additionalRequirements),
    };

    return this.prisma.projectRequirement.upsert({
      where: { projectId },
      create: data,
      update: {
        ...data,
        version: { increment: 1 },
      },
    });
  }

  async get(projectId: string): Promise<ProjectRequirement> {
    const requirement = await this.prisma.projectRequirement.findUnique({
      where: { projectId },
    });
    if (!requirement) {
      throw new AppError(
        ErrorCode.REQUIREMENTS_NOT_FOUND,
        'No requirements have been saved for this project yet.',
      );
    }
    return requirement;
  }
}

function toJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

import { Injectable } from '@nestjs/common';
import { Project } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ListProjectsQuery } from './dto/list-projects.query';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateProjectDto): Promise<Project> {
    return this.prisma.project.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        type: dto.type,
      },
    });
  }

  async list(
    ownerId: string,
    query: ListProjectsQuery,
  ): Promise<{ items: Project[]; nextCursor: string | null }> {
    const items = await this.prisma.project.findMany({
      where: { ownerId, status: query.status },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * The single ownership choke point. Every other method in this service —
   * and ProjectOwnershipGuard for other modules' controllers — goes through
   * this so "does the project exist" and "does this user own it" can never
   * be checked separately (that gap is exactly how an ID swap becomes an
   * authorization bypass — see API.md "Never trust project/resource IDs
   * supplied by the client").
   */
  async getOwned(ownerId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project || project.ownerId !== ownerId) {
      // Same error for "doesn't exist" and "exists but isn't yours" —
      // returning FORBIDDEN would leak that the ID is valid.
      throw new AppError(
        ErrorCode.PROJECT_NOT_FOUND,
        'Project not found.',
      );
    }
    return project;
  }

  async update(
    ownerId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    await this.getOwned(ownerId, projectId);
    return this.prisma.project.update({
      where: { id: projectId },
      data: dto,
    });
  }

  async archive(ownerId: string, projectId: string): Promise<Project> {
    await this.getOwned(ownerId, projectId);
    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async delete(ownerId: string, projectId: string): Promise<void> {
    await this.getOwned(ownerId, projectId);
    await this.prisma.project.delete({ where: { id: projectId } });
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ListProjectsQuery } from './dto/list-projects.query';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1/projects')
@UseGuards(SessionAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.create(user.id, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListProjectsQuery,
  ) {
    return this.projectsService.list(user.id, query);
  }

  @Get(':projectId')
  @UseGuards(ProjectOwnershipGuard)
  get(@Param('projectId') projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.getOwned(user.id, projectId);
  }

  @Patch(':projectId')
  @UseGuards(ProjectOwnershipGuard)
  update(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(user.id, projectId, dto);
  }

  @Post(':projectId/archive')
  @UseGuards(ProjectOwnershipGuard)
  archive(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.archive(user.id, projectId);
  }

  @Delete(':projectId')
  @UseGuards(ProjectOwnershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.projectsService.delete(user.id, projectId);
  }
}

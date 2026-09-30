import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ResearchPlansService } from './research-plans.service';
import { CreateResearchPlanDto } from './dto/create-research-plan.dto';
import { UpdateResearchPlanDto } from './dto/update-research-plan.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class ResearchPlansController {
  constructor(private readonly researchPlansService: ResearchPlansService) {}

  @Post('projects/:projectId/research-plans')
  @UseGuards(ProjectOwnershipGuard)
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateResearchPlanDto,
  ) {
    return this.researchPlansService.create(projectId, dto);
  }

  /**
   * The Planner role. Not in API.md as written — flagging this as a new
   * route added for the AI Gateway slice, following the same
   * /projects/:projectId/research-plans base path rather than inventing a
   * separate one.
   */
  @Post('projects/:projectId/research-plans/generate')
  @UseGuards(ProjectOwnershipGuard)
  generate(@Param('projectId') projectId: string) {
    return this.researchPlansService.generate(projectId);
  }

  @Get('research-plans/:researchPlanId')
  get(
    @Param('researchPlanId') researchPlanId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.researchPlansService.getOwned(user.id, researchPlanId);
  }

  @Patch('research-plans/:researchPlanId')
  update(
    @Param('researchPlanId') researchPlanId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateResearchPlanDto,
  ) {
    return this.researchPlansService.update(user.id, researchPlanId, dto);
  }
}
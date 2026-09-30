import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Project } from '@prisma/client';
import { ProjectsService } from '../../modules/projects/projects.service';
import type { AuthenticatedUser } from '../../modules/auth/auth.service';

/**
 * Requires SessionAuthGuard to have already run (so req.user is set).
 * Verifies :projectId in the route belongs to the current user and
 * attaches the loaded project to req.project so downstream services don't
 * re-fetch it. Any module whose routes are nested under
 * /projects/:projectId/... should use this rather than re-implementing the
 * ownership check inline.
 */
@Injectable()
export class ProjectOwnershipGuard implements CanActivate {
  constructor(private readonly projectsService: ProjectsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser; project?: Project }>();

    const projectId = request.params.projectId;
    const project = await this.projectsService.getOwned(
      request.user.id,
      projectId,
    );
    request.project = project;
    return true;
  }
}

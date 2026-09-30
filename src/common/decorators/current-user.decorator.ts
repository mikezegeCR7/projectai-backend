import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../modules/auth/auth.service';

/**
 * Reads the user attached by SessionAuthGuard. Only valid on routes
 * decorated with @UseGuards(SessionAuthGuard) — using it elsewhere will
 * return undefined, so ownership checks must never rely on this alone
 * without the guard also being present.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    return request.user;
  },
);

import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { AppError, ErrorCode } from '../errors/app-error';
import { SESSION_COOKIE_NAME } from '../../modules/auth/session.util';

/**
 * Every protected route must go through this guard — it's what makes
 * "authenticated user" a real, DB-backed fact rather than a client claim.
 * Attaches the resolved user to `req.user` for @CurrentUser() to read.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME] as
      | string
      | undefined;

    if (!rawToken) {
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required.',
      );
    }

    const user = await this.authService.validateSession(rawToken);
    if (!user) {
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'Session is invalid or has expired.',
      );
    }

    (request as Request & { user: typeof user }).user = user;
    return true;
  }
}

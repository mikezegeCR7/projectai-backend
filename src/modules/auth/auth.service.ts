import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  SESSION_MAX_AGE_MS,
  generateSessionToken,
  hashSessionToken,
} from './session.util';

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    dto: RegisterDto,
    req: Pick<Request, 'ip' | 'headers'>,
  ): Promise<{ user: AuthenticatedUser; rawToken: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new AppError(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists.',
      );
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });

    const rawToken = await this.createSession(user.id, req);
    return { user: toPublicUser(user), rawToken };
  }

  async login(
    dto: LoginDto,
    req: Pick<Request, 'ip' | 'headers'>,
  ): Promise<{ user: AuthenticatedUser; rawToken: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user || user.deletedAt) {
      throw new AppError(
        ErrorCode.INVALID_CREDENTIALS,
        'Incorrect email or password.',
      );
    }

    const passwordValid = await argon2.verify(
      user.passwordHash,
      dto.password,
    );
    if (!passwordValid) {
      throw new AppError(
        ErrorCode.INVALID_CREDENTIALS,
        'Incorrect email or password.',
      );
    }

    const rawToken = await this.createSession(user.id, req);
    return { user: toPublicUser(user), rawToken };
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashSessionToken(rawToken);
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  /**
   * Looks up the session by the cookie's raw token. Returns null (never
   * throws) on any invalid/expired session — callers decide how to react,
   * so this can be reused by both the guard (which throws UNAUTHENTICATED)
   * and optional-auth call sites later.
   */
  async validateSession(rawToken: string): Promise<AuthenticatedUser | null> {
    if (!rawToken) return null;
    const tokenHash = hashSessionToken(rawToken);

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      // Best-effort cleanup of the expired row; not on the critical path.
      await this.prisma.session
        .delete({ where: { id: session.id } })
        .catch(() => undefined);
      return null;
    }
    if (session.user.deletedAt) return null;

    await this.prisma.session
      .update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);

    return toPublicUser(session.user);
  }

  private async createSession(
    userId: string,
    req: Pick<Request, 'ip' | 'headers'>,
  ): Promise<string> {
    const rawToken = generateSessionToken();
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });
    return rawToken;
  }
}

function toPublicUser(user: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

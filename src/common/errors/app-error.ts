import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error codes used across the API. Keep this list append-only — do not
 * repurpose an existing code for a different meaning, since frontend
 * error handling matches on `code`, not `message`.
 */
export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_REGISTERED = 'EMAIL_ALREADY_REGISTERED',
  FORBIDDEN = 'FORBIDDEN',
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  REQUIREMENTS_NOT_FOUND = 'REQUIREMENTS_NOT_FOUND',
  RESEARCH_PLAN_NOT_FOUND = 'RESEARCH_PLAN_NOT_FOUND',
  RESEARCH_RUN_NOT_FOUND = 'RESEARCH_RUN_NOT_FOUND',
  RESEARCH_RUN_NOT_CANCELLABLE = 'RESEARCH_RUN_NOT_CANCELLABLE',
  SOURCE_NOT_FOUND = 'SOURCE_NOT_FOUND',
  EVIDENCE_NOT_FOUND = 'EVIDENCE_NOT_FOUND',
  CLAIM_NOT_FOUND = 'CLAIM_NOT_FOUND',
  AI_GENERATION_FAILED = 'AI_GENERATION_FAILED',
  USAGE_LIMIT_REACHED = 'USAGE_LIMIT_REACHED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_CREDENTIALS]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: HttpStatus.CONFLICT,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.PROJECT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.REQUIREMENTS_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.RESEARCH_PLAN_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.RESEARCH_RUN_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.RESEARCH_RUN_NOT_CANCELLABLE]: HttpStatus.CONFLICT,
  [ErrorCode.SOURCE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.EVIDENCE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CLAIM_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.AI_GENERATION_FAILED]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.USAGE_LIMIT_REACHED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Throw this anywhere in a service/controller. The global exception filter
 * renders it into the { error: { code, message, details, requestId } }
 * contract from API.md.
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, STATUS_BY_CODE[code]);
  }
}
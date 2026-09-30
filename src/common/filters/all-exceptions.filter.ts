import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AppError, ErrorCode } from '../errors/app-error';

/**
 * Renders every thrown error — AppError, Nest's built-in HttpExceptions
 * (e.g. from ValidationPipe), and anything unexpected — into the single
 * error contract defined in API.md:
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 *
 * A requestId is always attached so a report from the frontend can be
 * traced to server logs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ??
      randomUUID();

    if (exception instanceof AppError) {
      response.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // ValidationPipe throws a BadRequestException whose response body is
      // { message: string[], error, statusCode } — normalize it.
      const message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as Record<string, unknown>).message)
            ? ((body as Record<string, unknown>).message as string[]).join(
                '; ',
              )
            : ((body as Record<string, unknown>).message as string) ||
              exception.message;

      response.status(status).json({
        error: {
          code:
            status === HttpStatus.BAD_REQUEST
              ? ErrorCode.VALIDATION_FAILED
              : status === HttpStatus.UNAUTHORIZED
                ? ErrorCode.UNAUTHENTICATED
                : status === HttpStatus.FORBIDDEN
                  ? ErrorCode.FORBIDDEN
                  : ErrorCode.INTERNAL_ERROR,
          message,
          details: {},
          requestId,
        },
      });
      return;
    }

    this.logger.error(
      `Unhandled exception [${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        details: {},
        requestId,
      },
    });
  }
}

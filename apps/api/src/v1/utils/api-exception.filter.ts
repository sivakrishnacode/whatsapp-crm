import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ApiError } from './respond.util';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal';
    let message = 'Internal server error';
    let headers: Record<string, string> | undefined;

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      code = exception.code;
      message = body.error?.message || exception.message;
      headers = exception.headers;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as any;
      message = typeof res === 'string' ? res : (res.message || exception.message);
      if (Array.isArray(message)) {
        message = message.join(', ');
      }
      if (status === HttpStatus.UNAUTHORIZED) code = 'unauthorized';
      else if (status === HttpStatus.FORBIDDEN) code = 'forbidden';
      else if (status === HttpStatus.NOT_FOUND) code = 'not_found';
      else code = 'bad_request';
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (headers) {
      for (const [key, val] of Object.entries(headers)) {
        response.setHeader(key, val);
      }
    }

    response.status(status).json({
      error: {
        code,
        message,
      },
    });
  }
}

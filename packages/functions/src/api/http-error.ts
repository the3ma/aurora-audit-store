import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

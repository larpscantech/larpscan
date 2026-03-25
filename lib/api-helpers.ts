import { NextResponse } from 'next/server';

export type ApiSuccess<T extends Record<string, unknown>> = { success: true } & T;
export type ApiError = { success: false; error: string };

/** 2xx response with arbitrary payload. */
export function ok<T extends Record<string, unknown>>(
  data: T,
  status = 200,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ success: true, ...data } as ApiSuccess<T>, { status });
}

/** Error response with a human-readable message. */
export function err(message: string, status = 400): NextResponse<ApiError> {
  return NextResponse.json({ success: false, error: message }, { status });
}

/** Wraps a route handler so unhandled errors return a tidy 500. */
export function withErrorHandler(
  handler: (req: Request) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'An unexpected error occurred';
      console.error('[route error]', message);
      return err(message, 500);
    }
  };
}

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../logger.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

interface ErrorBody {
  error: {
    message: string;
    code: string;
    requestId?: string;
  };
}

function buildErrorBody(
  message: string,
  code: string,
  requestId?: string,
): ErrorBody {
  return {
    error: {
      message,
      code,
      ...(requestId !== undefined ? { requestId } : {}),
    },
  };
}

export function errorHandler(err: Error, c: Context) {
  const requestId = c.req.header("x-request-id");

  if (err instanceof AppError) {
    logger.warn({ err, requestId }, "Application error");
    return c.json(
      buildErrorBody(err.message, err.code ?? "APP_ERROR", requestId),
      err.statusCode as ContentfulStatusCode,
    );
  }

  logger.error({ err, requestId }, "Unhandled error");

  // Report to Sentry if available at runtime
  const sentry = getSentryIfAvailable();
  if (sentry !== null) {
    sentry.captureException(err);
  }

  return c.json(
    buildErrorBody("Internal server error", "INTERNAL_ERROR", requestId),
    500,
  );
}

// Lazy Sentry integration — avoids hard dep so the package is optional
function getSentryIfAvailable(): { captureException: (e: unknown) => void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@sentry/node") as { captureException: (e: unknown) => void };
  } catch {
    return null;
  }
}

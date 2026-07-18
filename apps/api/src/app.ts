import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatchboxConfig } from "@catchbox/config";
import {
  authenticateBrowserSession,
  countLocalAccounts,
  createBrowserSession,
  getDatabaseHealth,
  InvalidCaptureCursorError,
  listTextCaptures,
  saveTextCaptureBatch,
  verifyLocalAccountPassword,
  type CatchboxDatabase,
} from "@catchbox/db";
import {
  captureBatchRequestSchema,
  captureBatchResponseSchema,
  captureListQuerySchema,
  captureListResponseSchema,
  currentAccountSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  loginRequestSchema,
  type ErrorEnvelope,
  type HealthResponse,
} from "@catchbox/shared";
import express, { type Request, type Response } from "express";

const SESSION_COOKIE = "catchbox_session";
const defaultWebDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface StructuredLogger {
  info(bindings: Record<string, unknown>): void;
  warn(bindings: Record<string, unknown>): void;
  error(bindings: Record<string, unknown>): void;
}

interface AppDependencies {
  database: CatchboxDatabase;
  config: CatchboxConfig;
  logger: StructuredLogger;
  webDistPath?: string;
}

interface ResponseSchema<Output> {
  parse(value: unknown): Output;
}

function validatedJson<Output>(
  response: Response,
  status: number,
  schema: ResponseSchema<Output>,
  value: unknown,
) {
  return response.status(status).json(schema.parse(value));
}

function errorResponse(response: Response, status: number, error: ErrorEnvelope) {
  return validatedJson(response, status, errorEnvelopeSchema, error);
}

function healthResponse(response: Response, status: number, health: HealthResponse["status"]) {
  return validatedJson(response, status, healthResponseSchema, { status: health });
}

function currentAccountResponse(
  response: Response,
  account: { id: string; username: string },
) {
  return validatedJson(response, 200, currentAccountSchema, {
    id: account.id,
    username: account.username,
  });
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const prefix = `${name}=`;
  const value = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : undefined;
}

export function createApp({
  database,
  config,
  logger,
  webDistPath = defaultWebDistPath,
}: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/v1/health/live", (_request, response) => {
    healthResponse(response, 200, "live");
  });

  app.get("/api/v1/health/ready", (_request, response) => {
    try {
      const health = getDatabaseHealth(database);
      const ready =
        health.journalMode === "wal" &&
        health.schemaReady &&
        health.writable &&
        countLocalAccounts(database) === 1;
      logger.info({ event: "readiness", ready });
      healthResponse(response, ready ? 200 : 503, ready ? "ready" : "not_ready");
    } catch {
      logger.warn({ event: "readiness", ready: false });
      healthResponse(response, 503, "not_ready");
    }
  });

  app.post("/api/v1/auth/login", async (request, response) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn({ event: "authentication_failure", reason: "invalid_request" });
      return errorResponse(response, 400, {
        code: "INVALID_REQUEST",
        message: "Login request is invalid",
      });
    }

    const account = await verifyLocalAccountPassword(
      database,
      parsed.data.username,
      parsed.data.password,
    );
    if (!account) {
      logger.warn({ event: "authentication_failure", username: parsed.data.username });
      return errorResponse(response, 401, {
        code: "INVALID_CREDENTIALS",
        message: "Username or password is incorrect",
      });
    }

    const session = createBrowserSession(database, account, {
      idleSeconds: config.sessionIdleSeconds,
      absoluteSeconds: config.sessionAbsoluteSeconds,
    });
    response.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookies,
      path: "/",
      expires: session.absoluteExpiresAt,
    });
    response.setHeader("cache-control", "no-store");
    logger.info({ event: "authentication_success", username: account.username });
    return currentAccountResponse(response, account);
  });

  function authenticatedAccount(request: Request, response: Response) {
    const token = readCookie(request, SESSION_COOKIE);
    const account = token
      ? authenticateBrowserSession(database, token, config.sessionIdleSeconds)
      : undefined;
    if (!account) {
      errorResponse(response, 401, {
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to continue",
      });
    }
    return account;
  }

  app.get("/api/v1/auth/me", (request, response) => {
    const account = authenticatedAccount(request, response);
    if (!account) return;

    response.setHeader("cache-control", "no-store");
    return currentAccountResponse(response, account);
  });

  app.post("/api/v1/capture-batches", (request, response) => {
    const account = authenticatedAccount(request, response);
    if (!account) return;

    const parsed = captureBatchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(response, 400, {
        code: "INVALID_REQUEST",
        message: "Capture batch request is invalid",
      });
    }

    const result = saveTextCaptureBatch(database, account.id, parsed.data);
    response.setHeader("cache-control", "no-store");
    return validatedJson(
      response,
      result.batch.result === "created" ? 201 : 200,
      captureBatchResponseSchema,
      result,
    );
  });

  app.get("/api/v1/captures", (request, response) => {
    const account = authenticatedAccount(request, response);
    if (!account) return;

    const query = captureListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return errorResponse(response, 400, {
        code: "INVALID_REQUEST",
        message: "Capture list query is invalid",
      });
    }

    try {
      const result = listTextCaptures(database, account.id, query.data);
      response.setHeader("cache-control", "no-store");
      return validatedJson(response, 200, captureListResponseSchema, result);
    } catch (error) {
      if (error instanceof InvalidCaptureCursorError) {
        return errorResponse(response, 400, {
          code: "INVALID_REQUEST",
          message: error.message,
        });
      }
      throw error;
    }
  });

  const webIndexPath = `${webDistPath}/index.html`;
  if (existsSync(webIndexPath)) {
    const webIndex = readFileSync(webIndexPath, "utf8");
    app.use(
      express.static(webDistPath, {
        index: false,
        setHeaders(response, filePath) {
          if (basename(filePath).startsWith("sw-") && filePath.endsWith(".js")) {
            response.setHeader("Service-Worker-Allowed", "/");
          }
        },
      }),
    );
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
      response.type("html").send(webIndex);
    });
  }

  app.use((_request, response) =>
    errorResponse(response, 404, { code: "NOT_FOUND", message: "Route not found" }),
  );

  app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
    const requestErrorType =
      error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (requestErrorType === "entity.parse.failed" || requestErrorType === "entity.too.large") {
      logger.warn({ event: "invalid_request", reason: requestErrorType });
      return errorResponse(response, 400, {
        code: "INVALID_REQUEST",
        message: "JSON request body is invalid",
      });
    }
    logger.error({ event: "request_error", error: error instanceof Error ? error.message : "unknown" });
    return errorResponse(response, 500, { code: "INTERNAL_ERROR", message: "Unexpected server error" });
  });

  return app;
}

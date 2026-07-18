import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadApiConfig } from "@catchbox/config";
import {
  bootstrapLocalAccount,
  openDatabase,
  runMigrations,
  type CatchboxDatabase,
} from "@catchbox/db";
import {
  currentAccountSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
} from "@catchbox/shared";
import { createApp, type StructuredLogger } from "./app";
import { startHttpServer } from "./server";

let dataDirectory: string;
let database: CatchboxDatabase;
let server: Server;
let baseUrl: string;
let logs: Record<string, unknown>[];

const logger: StructuredLogger = {
  info(bindings) {
    logs.push(bindings);
  },
  warn(bindings) {
    logs.push(bindings);
  },
  error(bindings) {
    logs.push(bindings);
  },
};

beforeEach(async () => {
  logs = [];
  dataDirectory = mkdtempSync(join(tmpdir(), "catchbox-api-test-"));
  database = openDatabase(dataDirectory);
  runMigrations(database);
  await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");

  const config = loadApiConfig({
    CATCHBOX_DATA_DIR: dataDirectory,
    CATCHBOX_BOOTSTRAP_USERNAME: "operator",
    CATCHBOX_BOOTSTRAP_PASSWORD: "a-strong-test-passphrase",
    NODE_ENV: "test",
  });
  const webDistPath = join(dataDirectory, "web-dist");
  mkdirSync(webDistPath);
  writeFileSync(join(webDistPath, "index.html"), '<!doctype html><div id="root"></div>');
  const app = createApp({ database, config, logger, webDistPath });
  server = await startHttpServer(app, { ...config, port: 0 }, logger);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  database.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("health endpoints", () => {
  test("reports liveness and persistence readiness without private data", async () => {
    const live = await fetch(`${baseUrl}/api/v1/health/live`);
    const ready = await fetch(`${baseUrl}/api/v1/health/ready`);

    expect(live.status).toBe(200);
    expect(healthResponseSchema.parse(await live.json())).toEqual({ status: "live" });
    expect(ready.status).toBe(200);
    expect(healthResponseSchema.parse(await ready.json())).toEqual({ status: "ready" });
    expect(logs).toContainEqual({ event: "startup", host: "127.0.0.1", port: 0 });
    expect(logs).toContainEqual({ event: "readiness", ready: true });
  });
});

describe("web application shell", () => {
  test("serves the built public shell without embedding protected account data", async () => {
    const response = await fetch(baseUrl);
    const body = await response.text();

    expect(logs).not.toContainEqual(expect.objectContaining({ event: "request_error" }));
    expect(response.status).toBe(200);
    expect(body).toContain('<div id="root"></div>');
    expect(body).not.toContain("operator");
  });
});

describe("browser authentication", () => {
  test("rejects login fields outside the shared request contract", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "operator",
        password: "a-strong-test-passphrase",
        clientKind: "native",
      }),
    });

    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await response.json())).toEqual({
      code: "INVALID_REQUEST",
      message: "Login request is invalid",
    });
  });

  test("rejects invalid credentials with the common error envelope and safe logs", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "wrong-password" }),
    });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await response.json())).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Username or password is incorrect",
    });
    expect(logs).toContainEqual({ event: "authentication_failure", username: "operator" });
    expect(JSON.stringify(logs)).not.toContain("wrong-password");
  });

  test("creates a strict opaque cookie and returns the current account only with it", async () => {
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "a-strong-test-passphrase" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";", 1)[0];

    expect(login.status).toBe(200);
    expect(setCookie).toContain("catchbox_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=strict");
    expect(currentAccountSchema.parse(await login.json())).toMatchObject({ username: "operator" });

    const authenticated = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie },
    });
    expect(authenticated.status).toBe(200);
    expect(currentAccountSchema.parse(await authenticated.json())).toMatchObject({
      username: "operator",
    });

    const unauthenticated = await fetch(`${baseUrl}/api/v1/auth/me`);
    expect(unauthenticated.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await unauthenticated.json())).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in to continue",
    });
    expect(logs).toContainEqual({ event: "authentication_success", username: "operator" });
    expect(JSON.stringify(logs)).not.toContain(cookie.split("=")[1]);
  });
});

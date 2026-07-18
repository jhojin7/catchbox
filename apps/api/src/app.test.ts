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
  captureBatchResponseSchema,
  captureListResponseSchema,
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

async function signIn() {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "a-strong-test-passphrase" }),
  });
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

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

describe("online text capture", () => {
  test("persists one authenticated text batch and lists it through the public API", async () => {
    const cookie = await signIn();
    const request = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      source: { platform: "script", app: "integration-test" },
      items: [
        {
          clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
          type: "text",
          text: "Remember the adapter",
        },
      ],
    };

    const created = await fetch(`${baseUrl}/api/v1/capture-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(created.status).toBe(201);
    const createdBody = captureBatchResponseSchema.parse(await created.json());
    expect(createdBody).toMatchObject({
      batch: { clientBatchId: request.clientBatchId, result: "created" },
      items: [
        {
          clientItemId: request.items[0].clientItemId,
          result: "created",
          type: "text",
          state: "ready",
        },
      ],
    });

    const listed = await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(captureListResponseSchema.parse(await listed.json())).toEqual({
      captures: [
        {
          id: createdBody.items[0].id,
          batchId: createdBody.batch.id,
          clientItemId: request.items[0].clientItemId,
          type: "text",
          text: "Remember the adapter",
          state: "ready",
          capturedAt: request.capturedAt,
          receivedAt: createdBody.batch.receivedAt,
        },
      ],
      nextCursor: null,
    });
  });

  test("returns the original result for duplicate batch and item identities", async () => {
    const cookie = await signIn();
    const original = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      items: [
        {
          clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
          type: "text",
          text: "Original text",
        },
      ],
    };
    const submit = (body: unknown) =>
      fetch(`${baseUrl}/api/v1/capture-batches`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const firstResponse = await submit(original);
    const first = captureBatchResponseSchema.parse(await firstResponse.json());
    const duplicateBatchResponse = await submit({
      ...original,
      items: [
        {
          clientItemId: "e9e253bc-2244-4931-a713-1401f84f7b25",
          type: "text",
          text: "Conflicting retry text",
        },
      ],
    });
    const duplicateItemResponse = await submit({
      ...original,
      clientBatchId: "4a1e561c-f01c-4ab6-a055-cab17d45e7f2",
      items: [{ ...original.items[0], text: "Another conflicting retry" }],
    });

    expect(firstResponse.status).toBe(201);
    expect(duplicateBatchResponse.status).toBe(200);
    expect(captureBatchResponseSchema.parse(await duplicateBatchResponse.json())).toEqual({
      batch: { ...first.batch, result: "existing" },
      items: [{ ...first.items[0], result: "existing" }],
    });
    expect(duplicateItemResponse.status).toBe(200);
    expect(captureBatchResponseSchema.parse(await duplicateItemResponse.json())).toEqual({
      batch: { ...first.batch, result: "existing" },
      items: [{ ...first.items[0], result: "existing" }],
    });

    const listed = await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie } });
    const page = captureListResponseSchema.parse(await listed.json());
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].text).toBe("Original text");
  });

  test("rejects unauthenticated and invalid capture requests without exposing data", async () => {
    const validRequest = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      items: [
        {
          clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
          type: "text",
          text: "Must remain private",
        },
      ],
    };
    const unauthorizedCreate = await fetch(`${baseUrl}/api/v1/capture-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest),
    });
    const unauthorizedList = await fetch(`${baseUrl}/api/v1/captures`);

    expect(unauthorizedCreate.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await unauthorizedCreate.json()).code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(unauthorizedList.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await unauthorizedList.json()).code).toBe(
      "AUTHENTICATION_REQUIRED",
    );

    const cookie = await signIn();
    const invalidCreate = await fetch(`${baseUrl}/api/v1/capture-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ...validRequest,
        items: [{ ...validRequest.items[0], text: "   " }],
      }),
    });
    const malformedCreate = await fetch(`${baseUrl}/api/v1/capture-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    });
    const invalidCursor = await fetch(`${baseUrl}/api/v1/captures?cursor=not-a-real-cursor`, {
      headers: { cookie },
    });
    const emptyInbox = await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie } });

    expect(invalidCreate.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await invalidCreate.json()).code).toBe("INVALID_REQUEST");
    expect(malformedCreate.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await malformedCreate.json()).code).toBe("INVALID_REQUEST");
    expect(invalidCursor.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await invalidCursor.json()).code).toBe("INVALID_REQUEST");
    expect(captureListResponseSchema.parse(await emptyInbox.json()).captures).toEqual([]);
  });

  test("lists captures in stable reverse chronology through an opaque cursor", async () => {
    const cookie = await signIn();
    const submit = async (clientBatchId: string, clientItemId: string, text: string) => {
      const response = await fetch(`${baseUrl}/api/v1/capture-batches`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          clientBatchId,
          capturedAt: new Date().toISOString(),
          items: [{ clientItemId, type: "text", text }],
        }),
      });
      expect(response.status).toBe(201);
    };

    await submit(
      "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
      "First capture",
    );
    await Bun.sleep(2);
    await submit(
      "4a1e561c-f01c-4ab6-a055-cab17d45e7f2",
      "e9e253bc-2244-4931-a713-1401f84f7b25",
      "Second capture",
    );

    const firstPageResponse = await fetch(`${baseUrl}/api/v1/captures?limit=1`, {
      headers: { cookie },
    });
    const firstPage = captureListResponseSchema.parse(await firstPageResponse.json());
    expect(firstPage.captures.map((capture) => capture.text)).toEqual(["Second capture"]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPageResponse = await fetch(
      `${baseUrl}/api/v1/captures?limit=1&cursor=${firstPage.nextCursor}`,
      { headers: { cookie } },
    );
    const secondPage = captureListResponseSchema.parse(await secondPageResponse.json());
    expect(secondPage.captures.map((capture) => capture.text)).toEqual(["First capture"]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

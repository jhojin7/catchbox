import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadApiConfig } from "@catchbox/config";
import {
  bootstrapLocalAccount,
  findLocalAccountByUsername,
  openDatabase,
  runMigrations,
  type CatchboxDatabase,
} from "@catchbox/db";
import { insertSyntheticAccount } from "@catchbox/db/test-support";
import {
  captureBatchResponseSchema,
  captureListResponseSchema,
  currentAccountSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  outboxStatusResponseSchema,
  tokenLoginResponseSchema,
  type SessionClientKind,
} from "@catchbox/shared";
import { createApp, type StructuredLogger } from "./app";
import { startHttpServer } from "./server";

let dataDirectory: string;
let database: CatchboxDatabase;
let server: Server;
let baseUrl: string;
let logs: Record<string, unknown>[];
let currentTime: Date;

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
  currentTime = new Date("2026-07-18T00:00:00.000Z");
  dataDirectory = mkdtempSync(join(tmpdir(), "catchbox-api-test-"));
  database = openDatabase(dataDirectory);
  runMigrations(database);
  await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");

  const config = loadApiConfig({
    CATCHBOX_DATA_DIR: dataDirectory,
    CATCHBOX_BOOTSTRAP_USERNAME: "operator",
    CATCHBOX_BOOTSTRAP_PASSWORD: "a-strong-test-passphrase",
    CATCHBOX_SESSION_IDLE_SECONDS: "60",
    CATCHBOX_SESSION_ABSOLUTE_SECONDS: "120",
    CATCHBOX_SECURE_COOKIES: "true",
    NODE_ENV: "test",
  });
  const webDistPath = join(dataDirectory, "web-dist");
  mkdirSync(webDistPath);
  writeFileSync(join(webDistPath, "index.html"), '<!doctype html><div id="root"></div>');
  const app = createApp({ database, config, logger, webDistPath, clock: () => currentTime });
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

type TokenClientKind = Exclude<SessionClientKind, "browser">;

function login(
  password = "a-strong-test-passphrase",
  clientKind?: TokenClientKind,
  username = "operator",
) {
  return fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, ...(clientKind && { clientKind }) }),
  });
}

function sessionCookie(response: Response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function tokenLogin(
  clientKind: TokenClientKind,
  password = "a-strong-test-passphrase",
  username = "operator",
) {
  const response = await login(password, clientKind, username);
  return { response, credential: tokenLoginResponseSchema.parse(await response.json()) };
}

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
        clientKind: "browser",
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
    expect(setCookie.toLowerCase()).toContain("secure");
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
    expect(logs).toContainEqual({
      event: "authentication_success",
      username: "operator",
      clientKind: "browser",
    });
    expect(JSON.stringify(logs)).not.toContain(cookie.split("=")[1]);
  });

  test("issues a revocable opaque script token without setting a browser cookie", async () => {
    const { response, credential } = await tokenLogin("script");

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(credential.account.username).toBe("operator");
    expect(credential.expiresAt).toBe("2026-07-18T00:02:00.000Z");

    const current = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(current.status).toBe(200);
    expect(currentAccountSchema.parse(await current.json())).toEqual(credential.account);
    expect(JSON.stringify(logs)).not.toContain(credential.token);
  });

  test("rejects browser and token credentials after idle and absolute expiry", async () => {
    const idleCookie = sessionCookie(await login());
    currentTime = new Date("2026-07-18T00:00:30.000Z");
    expect(
      (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: idleCookie } })).status,
    ).toBe(200);
    currentTime = new Date("2026-07-18T00:01:31.000Z");
    expect(
      (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: idleCookie } })).status,
    ).toBe(401);

    currentTime = new Date("2026-07-18T01:00:00.000Z");
    const { credential: absoluteCredential } = await tokenLogin("android");
    currentTime = new Date("2026-07-18T01:00:59.000Z");
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${absoluteCredential.token}` },
        })
      ).status,
    ).toBe(200);
    currentTime = new Date("2026-07-18T01:02:01.000Z");
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${absoluteCredential.token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("logout revokes exactly the presented cookie or token", async () => {
    const cookie = sessionCookie(await login());
    const token = (await tokenLogin("ios")).credential.token;

    const browserLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(browserLogout.status).toBe(204);
    expect(browserLogout.headers.get("set-cookie")?.toLowerCase()).toContain("httponly");
    expect((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } })).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("password change verifies the current password and invalidates all older credentials", async () => {
    const cookie = sessionCookie(await login());
    const oldToken = (await tokenLogin("script")).credential.token;

    const wrongCurrent = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "wrong-current-password",
        newPassword: "a-different-strong-passphrase",
      }),
    });
    expect(wrongCurrent.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await wrongCurrent.json()).code).toBe("INVALID_CREDENTIALS");
    expect((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } })).status).toBe(200);

    currentTime = new Date("2026-07-18T00:00:20.000Z");
    const changed = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "a-strong-test-passphrase",
        newPassword: "a-different-strong-passphrase",
      }),
    });
    expect(changed.status).toBe(204);
    expect(changed.headers.get("set-cookie")?.toLowerCase()).toContain("httponly");
    expect((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } })).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${oldToken}` },
        })
      ).status,
    ).toBe(401);

    const oldPasswordLogin = await login();
    const newPasswordLogin = await login("a-different-strong-passphrase", "script");
    expect(oldPasswordLogin.status).toBe(401);
    expect(newPasswordLogin.status).toBe(200);
  });

  test("protects every existing private route without leaking credential state", async () => {
    for (const [path, method] of [
      ["/api/v1/auth/me", "GET"],
      ["/api/v1/auth/logout", "POST"],
      ["/api/v1/auth/change-password", "POST"],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(401);
      expect(errorEnvelopeSchema.parse(await response.json())).toEqual({
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to continue",
      });
    }

    const malformed = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: "Bearer definitely-not-valid" },
    });
    expect(errorEnvelopeSchema.parse(await malformed.json())).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in to continue",
    });
    expect(JSON.stringify(logs)).not.toContain("definitely-not-valid");

    const malformedCookie = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie: "catchbox_session=%" },
    });
    expect(malformedCookie.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await malformedCookie.json())).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in to continue",
    });
  });

  test("isolates existing private interfaces across two authenticated owners", async () => {
    const operator = findLocalAccountByUsername(database, "operator")!;
    const syntheticPassword = "synthetic-user-passphrase";
    const syntheticAccount = await insertSyntheticAccount(
      database,
      {
        id: "synthetic-user-id",
        username: "synthetic-user",
        accountKey: "synthetic-test-account",
        password: syntheticPassword,
      },
      currentTime,
    );

    const operatorCookie = sessionCookie(await login());
    const syntheticCredential = (
      await tokenLogin("script", syntheticPassword, syntheticAccount.username)
    ).credential;
    expect(
      (await login("a-strong-test-passphrase", "script", syntheticAccount.username)).status,
    ).toBe(401);
    expect((await login(syntheticPassword)).status).toBe(401);

    const operatorMe = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { cookie: operatorCookie },
    });
    const syntheticMe = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${syntheticCredential.token}` },
    });
    expect(currentAccountSchema.parse(await operatorMe.json())).toEqual({
      id: operator.id,
      username: operator.username,
    });
    expect(currentAccountSchema.parse(await syntheticMe.json())).toEqual(syntheticAccount);

    const crossOwnerChange = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { cookie: operatorCookie, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "a-strong-test-passphrase",
        newPassword: "a-different-strong-passphrase",
        userId: syntheticAccount.id,
      }),
    });
    expect(crossOwnerChange.status).toBe(400);

    const operatorLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: operatorCookie },
    });
    expect(operatorLogout.status).toBe(204);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${syntheticCredential.token}` },
        })
      ).status,
    ).toBe(200);

    const nextOperatorCookie = sessionCookie(await login());
    const operatorChange = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { cookie: nextOperatorCookie, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "a-strong-test-passphrase",
        newPassword: "a-different-strong-passphrase",
      }),
    });
    expect(operatorChange.status).toBe(204);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${syntheticCredential.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await login(syntheticPassword, "script", syntheticAccount.username)).status,
    ).toBe(200);
    expect((await login()).status).toBe(401);
    expect((await login("a-different-strong-passphrase")).status).toBe(200);
  });
});

describe("online text capture", () => {
  test("persists one authenticated text batch and lists it through the public API", async () => {
    const cookie = sessionCookie(await login());
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

  test("persists multiple text items as independently identified members of one batch", async () => {
    const cookie = sessionCookie(await login());
    const clientBatchId = "79d34d4b-662f-4d7b-95bc-a2cb509872a8";
    const items = [
      {
        clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
        type: "text",
        text: "First batch member",
      },
      {
        clientItemId: "e9e253bc-2244-4931-a713-1401f84f7b25",
        type: "text",
        text: "Second batch member",
      },
    ];
    const created = await fetch(`${baseUrl}/api/v1/capture-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        clientBatchId,
        capturedAt: "2026-07-18T08:15:30.000Z",
        items,
      }),
    });
    const result = captureBatchResponseSchema.parse(await created.json());
    const inbox = captureListResponseSchema.parse(
      await (await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie } })).json(),
    );

    expect(created.status).toBe(201);
    expect(result.items.map((item) => item.clientItemId).sort()).toEqual(
      items.map((item) => item.clientItemId).sort(),
    );
    expect(inbox.captures).toHaveLength(2);
    expect(new Set(inbox.captures.map((item) => item.batchId))).toEqual(
      new Set([result.batch.id]),
    );
  });

  test("retries selected items independently into one stable client batch", async () => {
    const cookie = sessionCookie(await login());
    const batch = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      items: [
        {
          clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
          type: "text",
          text: "Retry first",
        },
        {
          clientItemId: "e9e253bc-2244-4931-a713-1401f84f7b25",
          type: "text",
          text: "Retry second",
        },
      ],
    };
    const retry = (clientItemId: string) =>
      fetch(`${baseUrl}/api/v1/outbox/retry-items`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ batch, clientItemIds: [clientItemId] }),
      });

    const first = await retry(batch.items[0].clientItemId);
    const second = await retry(batch.items[1].clientItemId);
    const firstResult = captureBatchResponseSchema.parse(await first.json());
    const secondResult = captureBatchResponseSchema.parse(await second.json());
    const inbox = captureListResponseSchema.parse(
      await (await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie } })).json(),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondResult.batch.id).toBe(firstResult.batch.id);
    expect(firstResult.items.map((item) => item.clientItemId)).toEqual([
      batch.items[0].clientItemId,
    ]);
    expect(secondResult.items.map((item) => item.clientItemId)).toEqual([
      batch.items[1].clientItemId,
    ]);
    expect(inbox.captures).toHaveLength(2);
  });

  test("reconciles known stable identities through the authenticated outbox interface", async () => {
    const cookie = sessionCookie(await login());
    const request = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      items: [
        {
          clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
          type: "text",
          text: "Recover an ambiguous response",
        },
      ],
    };
    const created = captureBatchResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/v1/capture-batches`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).json(),
    );

    const unauthorized = await fetch(`${baseUrl}/api/v1/outbox/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientBatchIds: [request.clientBatchId],
        clientItemIds: [request.items[0].clientItemId],
      }),
    });
    const unauthorizedRetry = await fetch(`${baseUrl}/api/v1/outbox/retry-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch: request, clientItemIds: [request.items[0].clientItemId] }),
    });
    const invalid = await fetch(`${baseUrl}/api/v1/outbox/status`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ clientBatchIds: [], clientItemIds: [] }),
    });
    const reconciledResponse = await fetch(`${baseUrl}/api/v1/outbox/status`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        clientBatchIds: [request.clientBatchId, crypto.randomUUID()],
        clientItemIds: [request.items[0].clientItemId, crypto.randomUUID()],
      }),
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorizedRetry.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(reconciledResponse.status).toBe(200);
    expect(outboxStatusResponseSchema.parse(await reconciledResponse.json())).toEqual({
      batches: [
        {
          id: created.batch.id,
          clientBatchId: request.clientBatchId,
          capturedAt: request.capturedAt,
          receivedAt: created.batch.receivedAt,
          items: [
            {
              id: created.items[0].id,
              clientItemId: request.items[0].clientItemId,
              type: "text",
              state: "ready",
            },
          ],
        },
      ],
    });
  });

  test("returns the original result for duplicate batch and item identities", async () => {
    const cookie = sessionCookie(await login());
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

    const cookie = sessionCookie(await login());
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
    const cookie = sessionCookie(await login());
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

  test("accepts browser, script, and native credentials across all capture routes", async () => {
    const browserCookie = sessionCookie(await login());
    const scriptToken = (await tokenLogin("script")).credential.token;
    const androidToken = (await tokenLogin("android")).credential.token;
    const submissions: Array<{
      headers: Record<string, string>;
      clientBatchId: string;
      clientItemId: string;
      text: string;
    }> = [
      {
        headers: { cookie: browserCookie },
        clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
        clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
        text: "Browser capture",
      },
      {
        headers: { authorization: `Bearer ${scriptToken}` },
        clientBatchId: "4a1e561c-f01c-4ab6-a055-cab17d45e7f2",
        clientItemId: "e9e253bc-2244-4931-a713-1401f84f7b25",
        text: "Script capture",
      },
      {
        headers: { authorization: `Bearer ${androidToken}` },
        clientBatchId: "bbf1fb25-bbc7-4ae2-a665-378bdb0b6d1d",
        clientItemId: "41741223-f88e-4525-9a85-e999c42b2c2f",
        text: "Native capture",
      },
    ];

    for (const submission of submissions) {
      const response = await fetch(`${baseUrl}/api/v1/capture-batches`, {
        method: "POST",
        headers: { ...submission.headers, "content-type": "application/json" },
        body: JSON.stringify({
          clientBatchId: submission.clientBatchId,
          capturedAt: "2026-07-18T08:15:30.000Z",
          items: [
            {
              clientItemId: submission.clientItemId,
              type: "text",
              text: submission.text,
            },
          ],
        }),
      });
      expect(response.status).toBe(201);
    }

    const authenticationHeaders: Record<string, string>[] = [
      { cookie: browserCookie },
      { authorization: `Bearer ${scriptToken}` },
      { authorization: `Bearer ${androidToken}` },
    ];
    for (const headers of authenticationHeaders) {
      const response = await fetch(`${baseUrl}/api/v1/captures`, { headers });
      expect(response.status).toBe(200);
      expect(captureListResponseSchema.parse(await response.json()).captures).toHaveLength(3);
      const status = await fetch(`${baseUrl}/api/v1/outbox/status`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          clientBatchIds: submissions.map((submission) => submission.clientBatchId),
          clientItemIds: submissions.map((submission) => submission.clientItemId),
        }),
      });
      expect(status.status).toBe(200);
      expect(outboxStatusResponseSchema.parse(await status.json()).batches).toHaveLength(3);
    }
  });

  test("rejects expired and revoked browser and token credentials on all capture routes", async () => {
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
    const assertCaptureRoutesReject = async (headers: Record<string, string>) => {
      const create = await fetch(`${baseUrl}/api/v1/capture-batches`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(validRequest),
      });
      const list = await fetch(`${baseUrl}/api/v1/captures`, { headers });
      const status = await fetch(`${baseUrl}/api/v1/outbox/status`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          clientBatchIds: [validRequest.clientBatchId],
          clientItemIds: [validRequest.items[0].clientItemId],
        }),
      });

      for (const response of [create, list, status]) {
        expect(response.status).toBe(401);
        expect(errorEnvelopeSchema.parse(await response.json()).code).toBe(
          "AUTHENTICATION_REQUIRED",
        );
      }
    };

    const expiringCookie = sessionCookie(await login());
    const expiringToken = (await tokenLogin("script")).credential.token;
    currentTime = new Date("2026-07-18T00:01:01.000Z");
    await assertCaptureRoutesReject({ cookie: expiringCookie });
    await assertCaptureRoutesReject({ authorization: `Bearer ${expiringToken}` });

    currentTime = new Date("2026-07-18T01:00:00.000Z");
    const revokedCookie = sessionCookie(await login());
    const revokedToken = (await tokenLogin("ios")).credential.token;
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/logout`, {
          method: "POST",
          headers: { cookie: revokedCookie },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/auth/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${revokedToken}` },
        })
      ).status,
    ).toBe(204);
    await assertCaptureRoutesReject({ cookie: revokedCookie });
    await assertCaptureRoutesReject({ authorization: `Bearer ${revokedToken}` });
  });

  test("keeps capture identities and inboxes isolated across authenticated owners", async () => {
    const syntheticPassword = "synthetic-capture-passphrase";
    const syntheticAccount = await insertSyntheticAccount(
      database,
      {
        id: "synthetic-capture-user-id",
        username: "capture-user",
        accountKey: "synthetic-capture-account",
        password: syntheticPassword,
      },
      currentTime,
    );

    const operatorCookie = sessionCookie(await login());
    const syntheticToken = (
      await tokenLogin("script", syntheticPassword, syntheticAccount.username)
    ).credential.token;
    const sharedIdentities = {
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      capturedAt: "2026-07-18T08:15:30.000Z",
      clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
    };
    const submit = (headers: Record<string, string>, text: string) =>
      fetch(`${baseUrl}/api/v1/capture-batches`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          clientBatchId: sharedIdentities.clientBatchId,
          capturedAt: sharedIdentities.capturedAt,
          items: [
            {
              clientItemId: sharedIdentities.clientItemId,
              type: "text",
              text,
            },
          ],
        }),
      });

    const operatorCreated = await submit({ cookie: operatorCookie }, "Operator capture");
    const syntheticCreated = await submit(
      { authorization: `Bearer ${syntheticToken}` },
      "Synthetic capture",
    );
    expect(operatorCreated.status).toBe(201);
    expect(syntheticCreated.status).toBe(201);
    const operatorCreatedBody = captureBatchResponseSchema.parse(await operatorCreated.json());
    const syntheticCreatedBody = captureBatchResponseSchema.parse(await syntheticCreated.json());

    const operatorInbox = captureListResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/v1/captures`, { headers: { cookie: operatorCookie } })
      ).json(),
    );
    const syntheticInbox = captureListResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/v1/captures`, {
          headers: { authorization: `Bearer ${syntheticToken}` },
        })
      ).json(),
    );
    expect(operatorInbox.captures.map((capture) => capture.text)).toEqual(["Operator capture"]);
    expect(syntheticInbox.captures.map((capture) => capture.text)).toEqual([
      "Synthetic capture",
    ]);

    const statusBody = JSON.stringify({
      clientBatchIds: [sharedIdentities.clientBatchId],
      clientItemIds: [sharedIdentities.clientItemId],
    });
    const operatorStatus = outboxStatusResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/v1/outbox/status`, {
          method: "POST",
          headers: { cookie: operatorCookie, "content-type": "application/json" },
          body: statusBody,
        })
      ).json(),
    );
    const syntheticStatus = outboxStatusResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/v1/outbox/status`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${syntheticToken}`,
            "content-type": "application/json",
          },
          body: statusBody,
        })
      ).json(),
    );
    expect(operatorStatus.batches[0].id).toBe(operatorCreatedBody.batch.id);
    expect(syntheticStatus.batches[0].id).toBe(syntheticCreatedBody.batch.id);
    expect(operatorStatus.batches[0].id).not.toBe(syntheticStatus.batches[0].id);
  });
});

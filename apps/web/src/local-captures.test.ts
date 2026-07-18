import { afterEach, describe, expect, test } from "bun:test";
import type {
  CaptureBatchRequest,
  CaptureBatchResponse,
  CurrentAccount,
} from "@catchbox/shared";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { CaptureApiError } from "./capture-api";
import {
  authorizeOfflineAccount,
  CatchboxLocalDatabase,
  clearOfflineAuthorization,
  clearOfflineAuthorizationIfCurrent,
  discardFailedCapture,
  drainPendingCaptures,
  loadOfflineAuthorizationSnapshot,
  loadOfflineAuthorizedAccount,
  listLocalCaptures,
  retryFailedCapture,
  savePendingTextCapture,
} from "./local-captures";

const databases: CatchboxLocalDatabase[] = [];

function database(name = `catchbox-test-${crypto.randomUUID()}`) {
  const instance = new CatchboxLocalDatabase(name, { indexedDB, IDBKeyRange });
  databases.push(instance);
  return instance;
}

afterEach(async () => {
  const instances = databases.splice(0);
  for (const instance of instances) instance.close();
  const names = new Set(instances.map((instance) => instance.name));
  for (const name of names) {
    const instance = new CatchboxLocalDatabase(name, { indexedDB, IDBKeyRange });
    await instance.delete();
  }
});

describe("durable local text capture", () => {
  test("stores a complete identified batch and pending item atomically before submission", async () => {
    const db = database();
    const ids = [
      "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
    ];
    const saved = await savePendingTextCapture(
      "account-1",
      "Remember while offline",
      {
        database: db,
        createUuid: () => ids.shift()!,
        now: () => new Date("2026-07-18T08:15:30.000Z"),
      },
    );

    expect(saved).toMatchObject({
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
      text: "Remember while offline",
      syncStatus: "pending",
    });
    expect(await db.batches.get(saved.clientBatchId)).toEqual({
      clientBatchId: saved.clientBatchId,
      accountId: "account-1",
      capturedAt: "2026-07-18T08:15:30.000Z",
      syncStatus: "pending",
      attemptCount: 0,
      nextAttemptAt: "2026-07-18T08:15:30.000Z",
      request: {
        clientBatchId: saved.clientBatchId,
        capturedAt: "2026-07-18T08:15:30.000Z",
        source: { platform: "web", app: "catchbox-pwa" },
        items: [
          {
            clientItemId: saved.clientItemId,
            type: "text",
            text: "Remember while offline",
          },
        ],
      },
    });

    const reopened = database(db.name);
    db.close();
    expect(await listLocalCaptures("account-1", reopened)).toEqual([saved]);
  });

  test("submits only observably persisted work and keeps stable identities when synced", async () => {
    const db = database();
    const saved = await savePendingTextCapture("account-1", "Sync exactly once", {
      database: db,
      createUuid: (() => {
        const ids = [
          "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
          "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
        ];
        return () => ids.shift()!;
      })(),
      now: () => new Date("2026-07-18T08:15:30.000Z"),
    });
    let submissions = 0;
    const response: CaptureBatchResponse = {
      batch: {
        id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
        clientBatchId: saved.clientBatchId,
        result: "created",
        capturedAt: saved.capturedAt,
        receivedAt: "2026-07-18T08:15:31.000Z",
      },
      items: [
        {
          id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
          clientItemId: saved.clientItemId,
          result: "created",
          type: "text",
          state: "ready",
        },
      ],
    };

    const submit = async () => {
      submissions += 1;
      expect(await db.batches.get(saved.clientBatchId)).toMatchObject({ syncStatus: "pending" });
      expect(await db.items.get(saved.clientItemId)).toMatchObject({ syncStatus: "pending" });
      return response;
    };
    await drainPendingCaptures({ accountId: "account-1", database: db, submit });
    await drainPendingCaptures({ accountId: "account-1", database: db, submit });

    expect(submissions).toBe(1);
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "synced",
      serverResult: response,
    });
    expect(await listLocalCaptures("account-1", db)).toEqual([
      {
        ...saved,
        syncStatus: "synced",
        serverBatchId: response.batch.id,
        serverItemId: response.items[0].id,
        receivedAt: response.batch.receivedAt,
      },
    ]);
  });

  test("leaves ambiguous submissions pending for an idempotent later drain", async () => {
    const db = database();
    const saved = await savePendingTextCapture("account-1", "Retry the same identity", {
      database: db,
    });
    const submittedIds: string[] = [];

    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      submit: async (request) => {
        submittedIds.push(request.clientBatchId, request.items[0].clientItemId);
        throw new TypeError("connection disappeared");
      },
    });

    expect(submittedIds).toEqual([saved.clientBatchId, saved.clientItemId]);
    expect(await db.items.get(saved.clientItemId)).toMatchObject({ syncStatus: "pending" });
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({ syncStatus: "pending" });
  });

  test("persists bounded retry scheduling and drains only clock-eligible work", async () => {
    const db = database();
    let currentTime = new Date("2026-07-18T08:15:30.000Z");
    const saved = await savePendingTextCapture("account-1", "Retry with backoff", {
      database: db,
      now: () => currentTime,
    });
    let submissions = 0;
    let reconciliations = 0;
    const drain = () =>
      drainPendingCaptures({
        accountId: "account-1",
        database: db,
        clock: () => currentTime,
        retryPolicy: {
          baseDelayMs: 1_000,
          maximumDelayMs: 1_500,
          maximumAutomaticAttempts: 3,
        },
        reconcile: async () => {
          reconciliations += 1;
          return { batches: [] };
        },
        submit: async () => {
          submissions += 1;
          throw submissions === 1
            ? new TypeError("connection failed")
            : new CaptureApiError("Temporary server error", "INTERNAL_ERROR");
        },
      });

    await drain();
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "pending",
      attemptCount: 1,
      lastAttemptedAt: "2026-07-18T08:15:30.000Z",
      nextAttemptAt: "2026-07-18T08:15:31.000Z",
      lastErrorCode: "NETWORK_ERROR",
      lastErrorDetail: "Catchbox could not be reached. Check the connection and retry.",
    });

    currentTime = new Date("2026-07-18T08:15:30.999Z");
    await drain();
    expect({ submissions, reconciliations }).toEqual({ submissions: 1, reconciliations: 0 });

    currentTime = new Date("2026-07-18T08:15:31.000Z");
    await drain();
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "pending",
      attemptCount: 2,
      nextAttemptAt: "2026-07-18T08:15:32.500Z",
      lastErrorCode: "INTERNAL_ERROR",
    });

    currentTime = new Date("2026-07-18T08:15:32.500Z");
    await drain();
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "failed",
      attemptCount: 3,
      nextAttemptAt: "2026-07-18T08:15:34.000Z",
    });
    expect(await db.items.get(saved.clientItemId)).toMatchObject({
      syncStatus: "failed",
      lastErrorCode: "INTERNAL_ERROR",
    });
    expect({ submissions, reconciliations }).toEqual({ submissions: 3, reconciliations: 2 });
  });

  test("moves a non-retryable rejection directly to actionable failed state", async () => {
    const db = database();
    const saved = await savePendingTextCapture("account-1", "Rejected capture", {
      database: db,
    });

    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      submit: async () => {
        throw new CaptureApiError("Request rejected", "INVALID_REQUEST");
      },
    });

    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "failed",
      attemptCount: 1,
      lastErrorCode: "INVALID_REQUEST",
      lastErrorDetail: "Catchbox rejected this capture. Retry it or discard it.",
    });
    expect(await db.items.get(saved.clientItemId)).toMatchObject({
      syncStatus: "failed",
      lastErrorCode: "INVALID_REQUEST",
    });
  });

  test("reconciles a commit whose response was lost without resubmitting", async () => {
    const db = database();
    let currentTime = new Date("2026-07-18T08:15:30.000Z");
    const saved = await savePendingTextCapture("account-1", "Committed once", {
      database: db,
      now: () => currentTime,
    });
    const server = {
      batch: {
        id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
        clientBatchId: saved.clientBatchId,
        capturedAt: saved.capturedAt,
        receivedAt: "2026-07-18T08:15:31.000Z",
      },
      item: {
        id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
        clientItemId: saved.clientItemId,
        type: "text" as const,
        state: "ready" as const,
      },
    };
    let submissions = 0;

    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      clock: () => currentTime,
      submit: async () => {
        submissions += 1;
        throw new TypeError("response delivery failed after commit");
      },
    });
    currentTime = new Date("2026-07-18T08:15:31.000Z");
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      clock: () => currentTime,
      reconcile: async () => ({
        batches: [{ ...server.batch, items: [server.item] }],
      }),
      submit: async () => {
        submissions += 1;
        throw new Error("must not resubmit known work");
      },
    });

    expect(submissions).toBe(1);
    expect(await db.items.get(saved.clientItemId)).toMatchObject({
      syncStatus: "synced",
      serverBatchId: server.batch.id,
      serverItemId: server.item.id,
    });
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "synced",
      attemptCount: 2,
    });
  });

  test("manually retries or discards only the selected owner's failed entry", async () => {
    const db = database();
    const retry = await savePendingTextCapture("account-1", "Retry manually", { database: db });
    const discard = await savePendingTextCapture("account-1", "Discard manually", {
      database: db,
    });
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      submit: async () => {
        throw new CaptureApiError("Rejected", "INVALID_REQUEST");
      },
    });

    expect(await retryFailedCapture("account-2", retry.clientItemId, db)).toBe(false);
    expect(
      await retryFailedCapture(
        "account-1",
        retry.clientItemId,
        db,
        () => new Date("2026-07-18T09:00:00.000Z"),
      ),
    ).toBe(true);
    expect(await db.batches.get(retry.clientBatchId)).toMatchObject({
      syncStatus: "pending",
      nextAttemptAt: "2026-07-18T09:00:00.000Z",
    });
    expect(await discardFailedCapture("account-2", discard.clientItemId, db)).toBe(false);
    const siblingId = crypto.randomUUID();
    await db.items.add({
      ...(await db.items.get(discard.clientItemId))!,
      clientItemId: siblingId,
      text: "Failed sibling stays local",
    });
    const discardBatch = (await db.batches.get(discard.clientBatchId))!;
    await db.batches.update(discard.clientBatchId, {
      request: {
        ...discardBatch.request,
        items: [
          ...discardBatch.request.items,
          { clientItemId: siblingId, type: "text", text: "Failed sibling stays local" },
        ],
      },
    });
    expect(await discardFailedCapture("account-1", discard.clientItemId, db)).toBe(true);
    expect(await db.items.get(discard.clientItemId)).toBeUndefined();
    expect(await db.items.get(siblingId)).toMatchObject({ text: "Failed sibling stays local" });
    expect(await db.batches.get(discard.clientBatchId)).toMatchObject({
      request: {
        items: [
          { clientItemId: siblingId, type: "text", text: "Failed sibling stays local" },
        ],
      },
    });
    expect(await retryFailedCapture("account-1", siblingId, db)).toBe(true);
    const retriedClientItemIds: string[][] = [];
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      reconcile: async () => ({ batches: [] }),
      submit: async (request) => {
        retriedClientItemIds.push(request.items.map((item) => item.clientItemId));
        return {
          batch: {
            id: crypto.randomUUID(),
            clientBatchId: request.clientBatchId,
            result: "created",
            capturedAt: request.capturedAt,
            receivedAt: new Date().toISOString(),
          },
          items: request.items.map((item) => ({
            id: crypto.randomUUID(),
            clientItemId: item.clientItemId,
            result: "created",
            type: "text",
            state: "ready",
          })),
        };
      },
    });
    expect(retriedClientItemIds.every((ids) => ids.length === 1)).toBe(true);
    expect(new Set(retriedClientItemIds.flat())).toEqual(
      new Set([retry.clientItemId, siblingId]),
    );
    expect(await db.items.get(siblingId)).toMatchObject({ syncStatus: "synced" });
    expect(await db.items.get(retry.clientItemId)).toMatchObject({ syncStatus: "synced" });
    expect(await discardFailedCapture("account-1", retry.clientItemId, db)).toBe(false);
  });

  test("manual retry advances only the selected failed item in a retained batch", async () => {
    const db = database();
    const first = await savePendingTextCapture("account-1", "First failed member", {
      database: db,
    });
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      submit: async () => {
        throw new CaptureApiError("Rejected", "INVALID_REQUEST");
      },
    });
    const secondId = crypto.randomUUID();
    const firstItem = (await db.items.get(first.clientItemId))!;
    await db.items.add({ ...firstItem, clientItemId: secondId, text: "Second failed member" });
    const batch = (await db.batches.get(first.clientBatchId))!;
    await db.batches.update(first.clientBatchId, {
      request: {
        ...batch.request,
        items: [
          ...batch.request.items,
          { clientItemId: secondId, type: "text", text: "Second failed member" },
        ],
      },
    });
    expect(await retryFailedCapture("account-1", first.clientItemId, db)).toBe(true);

    const retryRequests: string[][] = [];
    let serverResult: CaptureBatchResponse | undefined;
    const retrySubmit = async ({
      batch: request,
      clientItemIds,
    }: {
      batch: CaptureBatchRequest;
      clientItemIds: string[];
    }): Promise<CaptureBatchResponse> => {
      retryRequests.push(clientItemIds);
      const result: CaptureBatchResponse = {
        batch: serverResult?.batch ?? {
          id: crypto.randomUUID(),
          clientBatchId: request.clientBatchId,
          result: "created",
          capturedAt: request.capturedAt,
          receivedAt: new Date().toISOString(),
        },
        items: request.items
          .filter((item) => clientItemIds.includes(item.clientItemId))
          .map((item) => ({
            id: crypto.randomUUID(),
            clientItemId: item.clientItemId,
            result: "created",
            type: "text",
            state: "ready",
          })),
      };
      serverResult ??= result;
      return result;
    };
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      reconcile: async () => ({ batches: [] }),
      retrySubmit,
    });

    expect(await db.items.get(first.clientItemId)).toMatchObject({ syncStatus: "synced" });
    expect(await db.items.get(secondId)).toMatchObject({ syncStatus: "failed" });
    expect(await db.batches.get(first.clientBatchId)).toMatchObject({ syncStatus: "failed" });

    expect(await retryFailedCapture("account-1", secondId, db)).toBe(true);
    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      reconcile: async () => ({
        batches: [
          {
            id: serverResult!.batch.id,
            clientBatchId: serverResult!.batch.clientBatchId,
            capturedAt: serverResult!.batch.capturedAt,
            receivedAt: serverResult!.batch.receivedAt,
            items: serverResult!.items.map(({ result: _result, ...item }) => item),
          },
        ],
      }),
      submit: async () => {
        throw new Error("partial retry must not use the whole-batch endpoint");
      },
      retrySubmit,
    });

    expect(retryRequests).toEqual([[first.clientItemId], [secondId]]);
    expect(await db.items.get(secondId)).toMatchObject({ syncStatus: "synced" });
    expect(await db.batches.get(first.clientBatchId)).toMatchObject({ syncStatus: "synced" });
  });

  test("propagates an observed authentication failure while retaining actionable failed work", async () => {
    const db = database();
    const saved = await savePendingTextCapture("account-1", "Require reauthentication", {
      database: db,
    });

    await expect(
      drainPendingCaptures({
        accountId: "account-1",
        database: db,
        submit: async () => {
          throw new CaptureApiError("Sign in to continue", "AUTHENTICATION_REQUIRED");
        },
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

    expect(await db.items.get(saved.clientItemId)).toMatchObject({
      syncStatus: "failed",
      lastErrorCode: "AUTHENTICATION_REQUIRED",
      lastErrorDetail: "Sign in again to continue syncing this capture.",
    });
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({
      syncStatus: "failed",
      lastErrorCode: "AUTHENTICATION_REQUIRED",
    });
  });

  test("drains pending work only for the authenticated local account", async () => {
    const db = database();
    const first = await savePendingTextCapture("account-1", "First owner's pending capture", {
      database: db,
    });
    const second = await savePendingTextCapture("account-2", "Second owner's pending capture", {
      database: db,
    });
    const submittedTexts: string[] = [];

    await drainPendingCaptures({
      accountId: "account-1",
      database: db,
      submit: async (request) => {
        submittedTexts.push(request.items[0].text);
        return {
          batch: {
            id: crypto.randomUUID(),
            clientBatchId: request.clientBatchId,
            result: "created",
            capturedAt: request.capturedAt,
            receivedAt: "2026-07-18T08:15:31.000Z",
          },
          items: [
            {
              id: crypto.randomUUID(),
              clientItemId: request.items[0].clientItemId,
              result: "created",
              type: "text",
              state: "ready",
            },
          ],
        };
      },
    });

    expect(submittedTexts).toEqual(["First owner's pending capture"]);
    expect(await db.items.get(first.clientItemId)).toMatchObject({ syncStatus: "synced" });
    expect(await db.items.get(second.clientItemId)).toMatchObject({ syncStatus: "pending" });
  });

  test("rolls back the complete local transaction when either identity cannot be stored", async () => {
    const db = database();
    const ids = [
      "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
    ];
    const fixedIds = () => {
      let index = 0;
      return () => ids[index++ % ids.length];
    };
    await savePendingTextCapture("account-1", "Original local capture", {
      database: db,
      createUuid: fixedIds(),
    });

    await expect(
      savePendingTextCapture("account-1", "Must not partially persist", {
        database: db,
        createUuid: fixedIds(),
      }),
    ).rejects.toThrow();

    expect(await db.batches.count()).toBe(1);
    expect(await db.items.toArray()).toMatchObject([
      { text: "Original local capture", syncStatus: "pending" },
    ]);
  });
});

describe("offline account shell", () => {
  test("upgrades a legacy account cache without implicitly authorizing an arbitrary owner", async () => {
    const name = `catchbox-test-${crypto.randomUUID()}`;
    const legacy = new Dexie(name, { indexedDB, IDBKeyRange });
    legacy.version(1).stores({
      batches: "&clientBatchId, accountId, capturedAt, syncStatus",
      items: "&clientItemId, clientBatchId, accountId, capturedAt, syncStatus",
      accounts: "&id",
    });
    const account: CurrentAccount = { id: "account-1", username: "operator" };
    await legacy.table<CurrentAccount, string>("accounts").put(account);
    await legacy.table("batches").put({
      clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
      accountId: account.id,
      capturedAt: "2026-07-18T08:15:30.000Z",
      syncStatus: "pending",
      request: {
        clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
        capturedAt: "2026-07-18T08:15:30.000Z",
        items: [
          {
            clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
            type: "text",
            text: "Legacy pending capture",
          },
        ],
      },
    });
    legacy.close();

    const upgraded = database(name);

    expect(await loadOfflineAuthorizedAccount(upgraded)).toBeUndefined();
    expect(await upgraded.accounts.get(account.id)).toEqual(account);
    expect(
      await upgraded.batches.get("79d34d4b-662f-4d7b-95bc-a2cb509872a8"),
    ).toMatchObject({
      attemptCount: 0,
      nextAttemptAt: "2026-07-18T08:15:30.000Z",
    });
  });

  test("recalls only the exact account named by the authorization marker", async () => {
    const db = database();
    const authorized: CurrentAccount = { id: "account-2", username: "operator" };
    const other: CurrentAccount = { id: "account-1", username: "someone-else" };

    await authorizeOfflineAccount(authorized, db);
    await db.accounts.put(other);

    expect(await loadOfflineAuthorizedAccount(db)).toEqual(authorized);
  });

  test("updates the marker deterministically when another account authenticates", async () => {
    const db = database();
    const first: CurrentAccount = { id: "account-1", username: "first" };
    const second: CurrentAccount = { id: "account-2", username: "second" };

    await authorizeOfflineAccount(first, db);
    await authorizeOfflineAccount(second, db);

    expect(await loadOfflineAuthorizedAccount(db)).toEqual(second);
  });

  test("does not let stale background work clear a newer authorization", async () => {
    const db = database();
    const account: CurrentAccount = { id: "account-1", username: "operator" };

    await authorizeOfflineAccount(account, db);
    const stale = await loadOfflineAuthorizationSnapshot(db);
    await authorizeOfflineAccount(account, db);
    const current = await loadOfflineAuthorizationSnapshot(db);
    await clearOfflineAuthorizationIfCurrent(stale!.generation, db);

    expect(current?.generation).not.toBe(stale?.generation);
    expect(await loadOfflineAuthorizedAccount(db)).toEqual(account);
  });

  test("clears offline authorization without deleting cached accounts or pending work", async () => {
    const db = database();
    const account: CurrentAccount = { id: "account-1", username: "operator" };
    const capture = await savePendingTextCapture(account.id, "Keep this pending", {
      database: db,
    });

    await authorizeOfflineAccount(account, db);
    await clearOfflineAuthorization(db);

    expect(await loadOfflineAuthorizedAccount(db)).toBeUndefined();
    expect(await db.accounts.get(account.id)).toEqual(account);
    expect(await db.items.get(capture.clientItemId)).toMatchObject({
      accountId: account.id,
      syncStatus: "pending",
    });
  });
});

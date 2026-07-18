import { afterEach, describe, expect, test } from "bun:test";
import type { CaptureBatchResponse, CurrentAccount } from "@catchbox/shared";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { CaptureApiError } from "./capture-api";
import {
  authorizeOfflineAccount,
  CatchboxLocalDatabase,
  clearOfflineAuthorization,
  clearOfflineAuthorizationIfCurrent,
  drainPendingCaptures,
  loadOfflineAuthorizationSnapshot,
  loadOfflineAuthorizedAccount,
  listLocalCaptures,
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

  test("propagates an observed authentication failure while retaining pending work", async () => {
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

    expect(await db.items.get(saved.clientItemId)).toMatchObject({ syncStatus: "pending" });
    expect(await db.batches.get(saved.clientBatchId)).toMatchObject({ syncStatus: "pending" });
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
    legacy.close();

    const upgraded = database(name);

    expect(await loadOfflineAuthorizedAccount(upgraded)).toBeUndefined();
    expect(await upgraded.accounts.get(account.id)).toEqual(account);
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

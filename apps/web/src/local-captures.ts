import {
  captureBatchRequestSchema,
  type CaptureBatchRequest,
  type CaptureBatchResponse,
  type CurrentAccount,
} from "@catchbox/shared";
import Dexie, { type DexieOptions, type Table } from "dexie";
import { CaptureApiError, submitTextCapture } from "./capture-api";

export type LocalSyncStatus = "pending" | "synced";
export const OUTBOX_SYNC_TAG = "catchbox-outbox";

export interface LocalCaptureBatch {
  clientBatchId: string;
  accountId: string;
  capturedAt: string;
  syncStatus: LocalSyncStatus;
  request: CaptureBatchRequest;
  serverResult?: CaptureBatchResponse;
}

export interface LocalCaptureItem {
  clientItemId: string;
  clientBatchId: string;
  accountId: string;
  type: "text";
  text: string;
  capturedAt: string;
  syncStatus: LocalSyncStatus;
  serverBatchId?: string;
  serverItemId?: string;
  receivedAt?: string;
}

export interface OfflineAuthorizationSnapshot {
  key: "active";
  accountId: string;
  generation: string;
}

const ACTIVE_OFFLINE_AUTHORIZATION_KEY = "active";

export class CatchboxLocalDatabase extends Dexie {
  batches!: Table<LocalCaptureBatch, string>;
  items!: Table<LocalCaptureItem, string>;
  accounts!: Table<CurrentAccount, string>;
  offlineAuthorizations!: Table<OfflineAuthorizationSnapshot, string>;

  constructor(name = "catchbox-local-v1", options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      batches: "&clientBatchId, accountId, capturedAt, syncStatus",
      items: "&clientItemId, clientBatchId, accountId, capturedAt, syncStatus",
      accounts: "&id",
    });
    this.version(2).stores({
      batches: "&clientBatchId, accountId, capturedAt, syncStatus",
      items: "&clientItemId, clientBatchId, accountId, capturedAt, syncStatus",
      accounts: "&id",
      offlineAuthorizations: "&key, accountId",
    });
  }
}

export const localDatabase = new CatchboxLocalDatabase();

interface SavePendingTextCaptureOptions {
  database?: CatchboxLocalDatabase;
  createUuid?: () => string;
  now?: () => Date;
}

export async function savePendingTextCapture(
  accountId: string,
  text: string,
  {
    database = localDatabase,
    createUuid = () => crypto.randomUUID(),
    now = () => new Date(),
  }: SavePendingTextCaptureOptions = {},
) {
  const clientBatchId = createUuid();
  const clientItemId = createUuid();
  const capturedAt = now().toISOString();
  const request = captureBatchRequestSchema.parse({
    clientBatchId,
    capturedAt,
    source: { platform: "web", app: "catchbox-pwa" },
    items: [{ clientItemId, type: "text", text }],
  });
  const batch: LocalCaptureBatch = {
    clientBatchId,
    accountId,
    capturedAt,
    syncStatus: "pending",
    request,
  };
  const item: LocalCaptureItem = {
    clientItemId,
    clientBatchId,
    accountId,
    type: "text",
    text,
    capturedAt,
    syncStatus: "pending",
  };

  await database.transaction("rw", database.batches, database.items, async () => {
    await database.batches.add(batch);
    await database.items.add(item);
  });
  return item;
}

export async function listLocalCaptures(
  accountId: string,
  database = localDatabase,
) {
  const items = await database.items.where("accountId").equals(accountId).sortBy("capturedAt");
  return items.reverse();
}

interface DrainPendingCapturesOptions {
  accountId: string;
  database?: CatchboxLocalDatabase;
  submit?: (request: CaptureBatchRequest) => Promise<CaptureBatchResponse>;
}

export async function drainPendingCaptures({
  accountId,
  database = localDatabase,
  submit = (request) => submitTextCapture(request),
}: DrainPendingCapturesOptions) {
  const pending = await database.batches
    .where("accountId")
    .equals(accountId)
    .filter((batch) => batch.syncStatus === "pending")
    .sortBy("capturedAt");

  for (const batch of pending) {
    try {
      const result = await submit(batch.request);
      const requestedItem = batch.request.items[0];
      const resultItem = result.items[0];
      if (
        result.batch.clientBatchId !== batch.clientBatchId ||
        resultItem.clientItemId !== requestedItem.clientItemId
      ) {
        throw new Error("Catchbox returned mismatched capture identities");
      }

      await database.transaction("rw", database.batches, database.items, async () => {
        await database.batches.update(batch.clientBatchId, {
          syncStatus: "synced",
          serverResult: result,
        });
        await database.items.update(requestedItem.clientItemId, {
          syncStatus: "synced",
          serverBatchId: result.batch.id,
          serverItemId: resultItem.id,
          receivedAt: result.batch.receivedAt,
        });
      });
    } catch (error) {
      if (error instanceof CaptureApiError && error.code === "AUTHENTICATION_REQUIRED") {
        throw error;
      }
      // Issue #4 leaves failed and ambiguous work pending for the next eligible drain.
    }
  }
}

export async function authorizeOfflineAccount(
  account: CurrentAccount,
  database = localDatabase,
) {
  await database.transaction(
    "rw",
    database.accounts,
    database.offlineAuthorizations,
    async () => {
      await database.accounts.put(account);
      await database.offlineAuthorizations.put({
        key: ACTIVE_OFFLINE_AUTHORIZATION_KEY,
        accountId: account.id,
        generation: crypto.randomUUID(),
      });
    },
  );
}

export async function clearOfflineAuthorization(database = localDatabase) {
  await database.offlineAuthorizations.delete(ACTIVE_OFFLINE_AUTHORIZATION_KEY);
}

export async function clearOfflineAuthorizationIfCurrent(
  generation: string,
  database = localDatabase,
) {
  await database.transaction("rw", database.offlineAuthorizations, async () => {
    const authorization = await database.offlineAuthorizations.get(
      ACTIVE_OFFLINE_AUTHORIZATION_KEY,
    );
    if (authorization?.generation === generation) {
      await database.offlineAuthorizations.delete(ACTIVE_OFFLINE_AUTHORIZATION_KEY);
    }
  });
}

export async function loadOfflineAuthorizationSnapshot(database = localDatabase) {
  return database.offlineAuthorizations.get(ACTIVE_OFFLINE_AUTHORIZATION_KEY);
}

export async function loadOfflineAuthorizedAccount(database = localDatabase) {
  return database.transaction(
    "r",
    database.accounts,
    database.offlineAuthorizations,
    async () => {
      const authorization = await loadOfflineAuthorizationSnapshot(database);
      return authorization
        ? database.accounts.get(authorization.accountId)
        : undefined;
    },
  );
}

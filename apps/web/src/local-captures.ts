import {
  captureBatchRequestSchema,
  captureBatchResponseSchema,
  type CaptureBatchRequest,
  type CaptureBatchResponse,
  type CurrentAccount,
  type OutboxStatusResponse,
  type OutboxRetryRequest,
} from "@catchbox/shared";
import Dexie, { type DexieOptions, type Table } from "dexie";
import {
  CaptureApiError,
  reconcileOutbox,
  retryOutboxItems,
  submitTextCapture,
} from "./capture-api";

export type LocalSyncStatus = "pending" | "failed" | "synced";
export type OutboxErrorCode =
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "INVALID_REQUEST"
  | "INVALID_CREDENTIALS"
  | "AUTHENTICATION_REQUIRED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";
export const OUTBOX_SYNC_TAG = "catchbox-outbox";

export interface LocalCaptureBatch {
  clientBatchId: string;
  accountId: string;
  capturedAt: string;
  syncStatus: LocalSyncStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptedAt?: string;
  lastErrorCode?: OutboxErrorCode;
  lastErrorDetail?: string;
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
  lastErrorCode?: OutboxErrorCode;
  lastErrorDetail?: string;
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
    this.version(3)
      .stores({
        batches: "&clientBatchId, accountId, capturedAt, syncStatus, nextAttemptAt",
        items: "&clientItemId, clientBatchId, accountId, capturedAt, syncStatus",
        accounts: "&id",
        offlineAuthorizations: "&key, accountId",
      })
      .upgrade((transaction) =>
        transaction
          .table<LocalCaptureBatch, string>("batches")
          .toCollection()
          .modify((batch) => {
            batch.attemptCount ??= 0;
            batch.nextAttemptAt ??= batch.capturedAt;
          }),
      );
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
    attemptCount: 0,
    nextAttemptAt: capturedAt,
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

export async function nextPendingCaptureAttempt(
  accountId: string,
  database = localDatabase,
) {
  const batches = await database.batches
    .where("accountId")
    .equals(accountId)
    .filter((batch) => batch.syncStatus === "pending")
    .sortBy("nextAttemptAt");
  return batches[0]?.nextAttemptAt;
}

interface DrainPendingCapturesOptions {
  accountId: string;
  database?: CatchboxLocalDatabase;
  submit?: (request: CaptureBatchRequest) => Promise<CaptureBatchResponse>;
  reconcile?: (
    request: { clientBatchIds: string[]; clientItemIds: string[] },
  ) => Promise<OutboxStatusResponse>;
  retrySubmit?: (request: OutboxRetryRequest) => Promise<CaptureBatchResponse>;
  clock?: () => Date;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maximumDelayMs: number;
  maximumAutomaticAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maximumDelayMs: 5 * 60_000,
  maximumAutomaticAttempts: 5,
};

function retryDelay(attemptCount: number, policy: RetryPolicy) {
  return Math.min(
    policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1),
    policy.maximumDelayMs,
  );
}

function deriveBatchSyncStatus(items: LocalCaptureItem[]): LocalSyncStatus {
  if (items.some((item) => item.syncStatus === "pending")) return "pending";
  if (items.some((item) => item.syncStatus === "failed")) return "failed";
  return "synced";
}

function classifyOutboxError(error: unknown) {
  if (error instanceof CaptureApiError) {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED":
      case "INVALID_CREDENTIALS":
        return {
          code: error.code,
          detail: "Sign in again to continue syncing this capture.",
          retryable: false,
          authenticationRequired: true,
        } as const;
      case "INTERNAL_ERROR":
        return {
          code: error.code,
          detail: "Catchbox could not store this capture right now. It will retry automatically.",
          retryable: true,
          authenticationRequired: false,
        } as const;
      case "INVALID_REQUEST":
        return {
          code: error.code,
          detail: "Catchbox rejected this capture. Retry it or discard it.",
          retryable: false,
          authenticationRequired: false,
        } as const;
      case "NOT_FOUND":
        return {
          code: error.code,
          detail: "The Catchbox server does not support this capture endpoint.",
          retryable: false,
          authenticationRequired: false,
        } as const;
    }
  }

  if (error instanceof TypeError) {
    return {
      code: "NETWORK_ERROR",
      detail: "Catchbox could not be reached. Check the connection and retry.",
      retryable: true,
      authenticationRequired: false,
    } as const;
  }
  return {
    code: "INVALID_RESPONSE",
    detail: "Catchbox returned an unreadable response. Check the server and retry.",
    retryable: true,
    authenticationRequired: false,
  } as const;
}

function reconciledResult(
  batch: LocalCaptureBatch,
  status: OutboxStatusResponse,
  eligibleClientItemIds: Set<string>,
): CaptureBatchResponse | undefined {
  const knownBatch = status.batches.find(
    (candidate) => candidate.clientBatchId === batch.clientBatchId,
  );
  if (!knownBatch) return undefined;
  const knownItems = batch.request.items
    .filter((requestedItem) => eligibleClientItemIds.has(requestedItem.clientItemId))
    .map((requestedItem) =>
      knownBatch.items.find(
        (candidate) => candidate.clientItemId === requestedItem.clientItemId,
      ),
    );
  if (knownItems.some((item) => !item)) return undefined;
  return captureBatchResponseSchema.parse({
    batch: {
      id: knownBatch.id,
      clientBatchId: knownBatch.clientBatchId,
      result: "existing",
      capturedAt: knownBatch.capturedAt,
      receivedAt: knownBatch.receivedAt,
    },
    items: knownItems.map((item) => ({ ...item!, result: "existing" })),
  });
}

async function markCaptureSynced(
  database: CatchboxLocalDatabase,
  batch: LocalCaptureBatch,
  result: CaptureBatchResponse,
  eligibleClientItemIds: Set<string>,
) {
  const resultItems = new Map(result.items.map((item) => [item.clientItemId, item]));
  if (
    result.batch.clientBatchId !== batch.clientBatchId ||
    batch.request.items.some(
      (item) =>
        eligibleClientItemIds.has(item.clientItemId) && !resultItems.has(item.clientItemId),
    )
  ) {
    throw new Error("Catchbox returned mismatched capture identities");
  }

  await database.transaction("rw", database.batches, database.items, async () => {
    for (const requestedItem of batch.request.items) {
      if (!eligibleClientItemIds.has(requestedItem.clientItemId)) continue;
      const resultItem = resultItems.get(requestedItem.clientItemId)!;
      await database.items.update(requestedItem.clientItemId, {
        syncStatus: "synced",
        serverBatchId: result.batch.id,
        serverItemId: resultItem.id,
        receivedAt: result.batch.receivedAt,
        lastErrorCode: undefined,
        lastErrorDetail: undefined,
      });
    }
    const items = await database.items
      .where("clientBatchId")
      .equals(batch.clientBatchId)
      .toArray();
    const syncStatus = deriveBatchSyncStatus(items);
    await database.batches.update(batch.clientBatchId, {
      syncStatus,
      serverResult: result,
      ...(syncStatus === "synced" && {
        lastErrorCode: undefined,
        lastErrorDetail: undefined,
      }),
    });
  });
}

export async function drainPendingCaptures({
  accountId,
  database = localDatabase,
  submit = (request) => submitTextCapture(request),
  reconcile = (request) => reconcileOutbox(request),
  retrySubmit = (request) => retryOutboxItems(request),
  clock = () => new Date(),
  retryPolicy = DEFAULT_RETRY_POLICY,
}: DrainPendingCapturesOptions) {
  const drainStartedAt = clock();
  const pending = await database.batches
    .where("accountId")
    .equals(accountId)
    .filter(
      (batch) =>
        batch.syncStatus === "pending" &&
        batch.nextAttemptAt <= drainStartedAt.toISOString(),
    )
    .sortBy("capturedAt");

  for (const batch of pending) {
    const eligibleItems = await database.items
      .where("clientBatchId")
      .equals(batch.clientBatchId)
      .filter((item) => item.syncStatus === "pending")
      .toArray();
    const eligibleClientItemIds = new Set(
      eligibleItems.map((item) => item.clientItemId),
    );
    if (eligibleClientItemIds.size === 0) continue;
    const attemptedAt = clock();
    const attemptCount = batch.attemptCount + 1;
    await database.batches.update(batch.clientBatchId, {
      attemptCount,
      lastAttemptedAt: attemptedAt.toISOString(),
    });
    try {
      let result: CaptureBatchResponse | undefined;
      if (batch.attemptCount > 0) {
        result = reconciledResult(
          batch,
          await reconcile({
            clientBatchIds: [batch.clientBatchId],
            clientItemIds: batch.request.items.map((item) => item.clientItemId),
          }),
          eligibleClientItemIds,
        );
      }
      if (!result) {
        const request = captureBatchRequestSchema.parse(batch.request);
        result =
          eligibleClientItemIds.size === request.items.length
            ? await submit(request)
            : await retrySubmit({
                batch: request,
                clientItemIds: [...eligibleClientItemIds],
              });
      }
      await markCaptureSynced(database, batch, result, eligibleClientItemIds);
    } catch (error) {
      const failure = classifyOutboxError(error);
      const syncStatus =
        !failure.retryable || attemptCount >= retryPolicy.maximumAutomaticAttempts
          ? "failed"
          : "pending";
      const nextAttemptAt = failure.authenticationRequired
        ? attemptedAt
        : new Date(attemptedAt.getTime() + retryDelay(attemptCount, retryPolicy));
      await database.transaction("rw", database.batches, database.items, async () => {
        for (const requestedItem of batch.request.items) {
          if (!eligibleClientItemIds.has(requestedItem.clientItemId)) continue;
          await database.items.update(requestedItem.clientItemId, {
            syncStatus,
            lastErrorCode: failure.code,
            lastErrorDetail: failure.detail,
          });
        }
        const items = await database.items
          .where("clientBatchId")
          .equals(batch.clientBatchId)
          .toArray();
        const batchSyncStatus = deriveBatchSyncStatus(items);
        await database.batches.update(batch.clientBatchId, {
          syncStatus: batchSyncStatus,
          nextAttemptAt: nextAttemptAt.toISOString(),
          lastErrorCode: failure.code,
          lastErrorDetail: failure.detail,
        });
      });
      if (failure.authenticationRequired) {
        throw error;
      }
    }
  }
}

export async function retryFailedCapture(
  accountId: string,
  clientItemId: string,
  database = localDatabase,
  clock = () => new Date(),
) {
  const entry = await findOwnedFailedEntry(accountId, clientItemId, database);
  if (!entry) return false;
  const { batch, item } = entry;

  await database.transaction("rw", database.batches, database.items, async () => {
    await database.batches.update(batch.clientBatchId, {
      syncStatus: "pending",
      nextAttemptAt: clock().toISOString(),
    });
    await database.items.update(item.clientItemId, { syncStatus: "pending" });
  });
  return true;
}

export async function discardFailedCapture(
  accountId: string,
  clientItemId: string,
  database = localDatabase,
) {
  const entry = await findOwnedFailedEntry(accountId, clientItemId, database);
  if (!entry) return false;
  const { batch, item } = entry;

  await database.transaction("rw", database.batches, database.items, async () => {
    await database.items.delete(item.clientItemId);
    const remainingRequestItems = batch.request.items.filter(
      (requestedItem) => requestedItem.clientItemId !== item.clientItemId,
    );
    const sibling = await database.items
      .where("clientBatchId")
      .equals(batch.clientBatchId)
      .first();
    if (!sibling) {
      await database.batches.delete(batch.clientBatchId);
    } else if (remainingRequestItems.length > 0) {
      await database.batches.update(batch.clientBatchId, {
        request: { ...batch.request, items: remainingRequestItems },
      });
    } else {
      throw new Error("Stored outbox batch has an item missing from its request");
    }
  });
  return true;
}

async function findOwnedFailedEntry(
  accountId: string,
  clientItemId: string,
  database: CatchboxLocalDatabase,
) {
  const item = await database.items.get(clientItemId);
  if (!item || item.accountId !== accountId || item.syncStatus !== "failed") return undefined;
  const batch = await database.batches.get(item.clientBatchId);
  if (!batch || batch.accountId !== accountId || batch.syncStatus !== "failed") return undefined;
  return { batch, item };
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

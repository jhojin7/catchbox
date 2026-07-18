import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type CaptureBatchRequest,
  type CaptureBatchResponse,
  type CaptureListResponse,
  type CaptureWriteResult,
  type OutboxStatusRequest,
  type OutboxStatusResponse,
  type OutboxRetryRequest,
  type SessionClientKind,
} from "@catchbox/shared";
import { and, asc, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { hashPassword } from "./password";
import * as schema from "./schema";

const LOCAL_ACCOUNT_KEY = "local-v1-account";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface CatchboxDatabase {
  sqlite: SQLiteDatabase;
  orm: BunSQLiteDatabase<typeof schema>;
  path: string;
  close(): void;
}

export function openDatabase(dataDirectory: string): CatchboxDatabase {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const path = `${dataDirectory}/catchbox.sqlite`;
  const sqlite = new SQLiteDatabase(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  return {
    sqlite,
    orm: drizzle(sqlite, { schema }),
    path,
    close() {
      sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sqlite.close();
    },
  };
}

export function runMigrations(database: CatchboxDatabase) {
  migrate(database.orm, { migrationsFolder });
}

export async function bootstrapLocalAccount(
  database: CatchboxDatabase,
  username: string,
  password: string,
) {
  const existing = database.orm
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.accountKey, LOCAL_ACCOUNT_KEY))
    .get();

  if (existing) {
    return { created: false as const, account: existing };
  }

  const now = new Date().toISOString();
  const account = { id: crypto.randomUUID(), username };
  const passwordHash = await hashPassword(password);

  database.orm.insert(schema.users).values({
    ...account,
    accountKey: LOCAL_ACCOUNT_KEY,
    passwordHash,
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { created: true as const, account };
}

export function findLocalAccountByUsername(database: CatchboxDatabase, username: string) {
  return database.orm.select().from(schema.users).where(eq(schema.users.username, username)).get();
}

export function countLocalAccounts(database: CatchboxDatabase) {
  return database.orm.select({ value: count() }).from(schema.users).get()?.value ?? 0;
}

export function getDatabaseHealth(database: CatchboxDatabase) {
  const journalMode = database.sqlite.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  const tableCount = database.sqlite
    .query(
      "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'sessions', 'capture_batches', 'capture_items')",
    )
    .get() as { value: number };
  const schemaReady = tableCount.value === 4;
  let writable = false;

  if (schemaReady) {
    try {
      database.sqlite.exec("BEGIN IMMEDIATE");
      database.sqlite.exec("UPDATE sessions SET last_used_at = last_used_at WHERE 0");
      database.sqlite.exec("ROLLBACK");
      writable = true;
    } catch {
      try {
        database.sqlite.exec("ROLLBACK");
      } catch {
        // The failed probe may have occurred before a transaction began.
      }
    }
  }

  return { journalMode: journalMode.journal_mode, schemaReady, writable };
}

function hashSessionToken(token: string) {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function verifyLocalAccountPassword(
  database: CatchboxDatabase,
  username: string,
  password: string,
) {
  const account = findLocalAccountByUsername(database, username);
  if (!account || !(await Bun.password.verify(password, account.passwordHash))) return undefined;
  return account;
}

export function createCredential(
  database: CatchboxDatabase,
  user: schema.UserRow,
  clientKind: SessionClientKind,
  lifetimes: { idleSeconds: number; absoluteSeconds: number },
  now = new Date(),
) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(tokenBytes).toString("base64url");
  const idleExpiresAt = new Date(now.getTime() + lifetimes.idleSeconds * 1_000);
  const absoluteExpiresAt = new Date(now.getTime() + lifetimes.absoluteSeconds * 1_000);

  database.orm.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    tokenHash: hashSessionToken(token),
    userId: user.id,
    clientKind,
    sessionVersion: user.sessionVersion,
    idleExpiresAt: idleExpiresAt.toISOString(),
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    lastUsedAt: now.toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  }).run();

  return { token, absoluteExpiresAt };
}

export function authenticateCredential(
  database: CatchboxDatabase,
  token: string,
  idleSeconds: number,
  allowedClientKinds: readonly SessionClientKind[],
  now = new Date(),
) {
  const match = database.orm
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSessionToken(token)),
        isNull(schema.sessions.revokedAt),
      ),
    )
    .get();

  if (
    !match ||
    !allowedClientKinds.includes(match.session.clientKind) ||
    match.session.sessionVersion !== match.user.sessionVersion ||
    match.session.idleExpiresAt <= now.toISOString() ||
    match.session.absoluteExpiresAt <= now.toISOString()
  ) {
    return undefined;
  }

  const nextIdleExpiry = new Date(
    Math.min(
      now.getTime() + idleSeconds * 1_000,
      new Date(match.session.absoluteExpiresAt).getTime(),
    ),
  );
  database.orm
    .update(schema.sessions)
    .set({ lastUsedAt: now.toISOString(), idleExpiresAt: nextIdleExpiry.toISOString() })
    .where(eq(schema.sessions.id, match.session.id))
    .run();

  return {
    account: match.user,
    credential: {
      id: match.session.id,
      clientKind: match.session.clientKind,
    },
  };
}

export function revokeCredential(
  database: CatchboxDatabase,
  credentialId: string,
  now = new Date(),
) {
  database.orm
    .update(schema.sessions)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(schema.sessions.id, credentialId), isNull(schema.sessions.revokedAt)))
    .run();
}

export async function changeLocalAccountPassword(
  database: CatchboxDatabase,
  userId: string,
  currentPassword: string,
  newPassword: string,
  now = new Date(),
) {
  const account = database.orm
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!account || !(await Bun.password.verify(currentPassword, account.passwordHash))) return false;

  const passwordHash = await hashPassword(newPassword);
  const changedAt = now.toISOString();

  return database.orm.transaction((transaction) => {
    const updated = transaction
      .update(schema.users)
      .set({
        passwordHash,
        sessionVersion: account.sessionVersion + 1,
        updatedAt: changedAt,
      })
      .where(
        and(
          eq(schema.users.id, account.id),
          eq(schema.users.passwordHash, account.passwordHash),
          eq(schema.users.sessionVersion, account.sessionVersion),
        ),
      )
      .returning({ id: schema.users.id })
      .get();
    if (!updated) return false;

    transaction
      .update(schema.sessions)
      .set({ revokedAt: changedAt })
      .where(and(eq(schema.sessions.userId, account.id), isNull(schema.sessions.revokedAt)))
      .run();

    return true;
  });
}

function captureResponse(
  batch: schema.CaptureBatchRow,
  items: schema.CaptureItemRow[],
  result: CaptureWriteResult,
): CaptureBatchResponse {
  return {
    batch: {
      id: batch.id,
      clientBatchId: batch.clientBatchId,
      result,
      capturedAt: batch.capturedAt,
      receivedAt: batch.receivedAt,
    },
    items: items.map((item) => captureItemResponse(item, result)),
  };
}

function newCaptureItemRow(
  batchId: string,
  userId: string,
  requestedItem: CaptureBatchRequest["items"][number],
  timestamp: string,
): schema.CaptureItemRow {
  return {
    id: crypto.randomUUID(),
    batchId,
    userId,
    clientItemId: requestedItem.clientItemId,
    type: "text",
    textContent: requestedItem.text,
    processingState: "ready",
    inboxState: "inbox",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newCaptureBatchRow(
  userId: string,
  request: CaptureBatchRequest,
  timestamp: string,
): schema.CaptureBatchRow {
  return {
    id: crypto.randomUUID(),
    userId,
    clientBatchId: request.clientBatchId,
    sourcePlatform: request.source?.platform ?? null,
    sourceApp: request.source?.app ?? null,
    capturedAt: request.capturedAt,
    receivedAt: timestamp,
  };
}

function captureItemResponse(
  item: schema.CaptureItemRow,
  result: CaptureWriteResult,
): CaptureBatchResponse["items"][number] {
  return {
    id: item.id,
    clientItemId: item.clientItemId,
    result,
    type: "text",
    state: "ready",
  };
}

export function saveTextCaptureBatch(
  database: CatchboxDatabase,
  userId: string,
  request: CaptureBatchRequest,
  now = new Date(),
): CaptureBatchResponse {
  return database.orm.transaction((transaction) => {
    const matchingBatch = transaction
      .select()
      .from(schema.captureBatches)
      .where(
        and(
          eq(schema.captureBatches.userId, userId),
          eq(schema.captureBatches.clientBatchId, request.clientBatchId),
        ),
      )
      .get();

    if (matchingBatch) {
      const items = transaction
        .select()
        .from(schema.captureItems)
        .where(eq(schema.captureItems.batchId, matchingBatch.id))
        .orderBy(asc(schema.captureItems.createdAt), asc(schema.captureItems.id))
        .all();
      if (items.length === 0) throw new Error("Stored capture batch has no item");
      return captureResponse(matchingBatch, items, "existing");
    }

    const matchingItem = transaction
      .select()
      .from(schema.captureItems)
      .where(
        and(
          eq(schema.captureItems.userId, userId),
          inArray(
            schema.captureItems.clientItemId,
            request.items.map((item) => item.clientItemId),
          ),
        ),
      )
      .get();

    if (matchingItem) {
      const batch = transaction
        .select()
        .from(schema.captureBatches)
        .where(eq(schema.captureBatches.id, matchingItem.batchId))
        .get();
      if (!batch) throw new Error("Stored capture item has no batch");
      const items = transaction
        .select()
        .from(schema.captureItems)
        .where(eq(schema.captureItems.batchId, batch.id))
        .orderBy(asc(schema.captureItems.createdAt), asc(schema.captureItems.id))
        .all();
      return captureResponse(batch, items, "existing");
    }

    const receivedAt = now.toISOString();
    const batch = newCaptureBatchRow(userId, request, receivedAt);
    const items = request.items.map((requestedItem) =>
      newCaptureItemRow(batch.id, userId, requestedItem, receivedAt),
    );

    transaction.insert(schema.captureBatches).values(batch).run();
    transaction.insert(schema.captureItems).values(items).run();

    return captureResponse(batch, items, "created");
  });
}

export function retryTextCaptureItems(
  database: CatchboxDatabase,
  userId: string,
  request: OutboxRetryRequest,
  now = new Date(),
): CaptureBatchResponse {
  return database.orm.transaction((transaction) => {
    let batch = transaction
      .select()
      .from(schema.captureBatches)
      .where(
        and(
          eq(schema.captureBatches.userId, userId),
          eq(schema.captureBatches.clientBatchId, request.batch.clientBatchId),
        ),
      )
      .get();
    const selectedIds = new Set(request.clientItemIds);
    const requestedItems = request.batch.items.filter((item) =>
      selectedIds.has(item.clientItemId),
    );
    const existingItems = transaction
      .select()
      .from(schema.captureItems)
      .where(
        and(
          eq(schema.captureItems.userId, userId),
          inArray(schema.captureItems.clientItemId, request.clientItemIds),
        ),
      )
      .all();
    const existingByClientId = new Map(
      existingItems.map((item) => [item.clientItemId, item]),
    );
    const receivedAt = now.toISOString();
    const batchResult: CaptureWriteResult = batch ? "existing" : "created";
    if (!batch) {
      batch = newCaptureBatchRow(userId, request.batch, receivedAt);
      transaction.insert(schema.captureBatches).values(batch).run();
    }

    const results: CaptureBatchResponse["items"] = [];
    for (const requestedItem of requestedItems) {
      let item = existingByClientId.get(requestedItem.clientItemId);
      let result: CaptureWriteResult = "existing";
      if (item && item.batchId !== batch.id) {
        throw new Error("Stored capture item belongs to another client batch");
      }
      if (!item) {
        result = "created";
        item = newCaptureItemRow(batch.id, userId, requestedItem, receivedAt);
        transaction.insert(schema.captureItems).values(item).run();
      }
      results.push(captureItemResponse(item, result));
    }

    return {
      batch: {
        id: batch.id,
        clientBatchId: batch.clientBatchId,
        result: batchResult,
        capturedAt: batch.capturedAt,
        receivedAt: batch.receivedAt,
      },
      items: results,
    };
  });
}

export function reconcileCaptureIdentities(
  database: CatchboxDatabase,
  userId: string,
  request: OutboxStatusRequest,
): OutboxStatusResponse {
  const matchedBatchIds = new Set<string>();

  if (request.clientBatchIds.length > 0) {
    const batches = database.orm
      .select({ id: schema.captureBatches.id })
      .from(schema.captureBatches)
      .where(
        and(
          eq(schema.captureBatches.userId, userId),
          inArray(schema.captureBatches.clientBatchId, request.clientBatchIds),
        ),
      )
      .all();
    for (const batch of batches) matchedBatchIds.add(batch.id);
  }

  if (request.clientItemIds.length > 0) {
    const items = database.orm
      .select({ batchId: schema.captureItems.batchId })
      .from(schema.captureItems)
      .where(
        and(
          eq(schema.captureItems.userId, userId),
          inArray(schema.captureItems.clientItemId, request.clientItemIds),
        ),
      )
      .all();
    for (const item of items) matchedBatchIds.add(item.batchId);
  }

  if (matchedBatchIds.size === 0) return { batches: [] };

  const rows = database.orm
    .select({ batch: schema.captureBatches, item: schema.captureItems })
    .from(schema.captureBatches)
    .innerJoin(schema.captureItems, eq(schema.captureItems.batchId, schema.captureBatches.id))
    .where(
      and(
        eq(schema.captureBatches.userId, userId),
        inArray(schema.captureBatches.id, [...matchedBatchIds]),
      ),
    )
    .all();
  const batches = new Map<string, OutboxStatusResponse["batches"][number]>();
  for (const { batch, item } of rows) {
    const reconciled = batches.get(batch.id) ?? {
      id: batch.id,
      clientBatchId: batch.clientBatchId,
      capturedAt: batch.capturedAt,
      receivedAt: batch.receivedAt,
      items: [],
    };
    reconciled.items.push({
      id: item.id,
      clientItemId: item.clientItemId,
      type: item.type,
      state: item.processingState,
    });
    batches.set(batch.id, reconciled);
  }

  return {
    batches: [...batches.values()].sort((left, right) =>
      left.clientBatchId.localeCompare(right.clientBatchId),
    ),
  };
}

interface CaptureCursorValue {
  receivedAt: string;
  id: string;
}

export class InvalidCaptureCursorError extends Error {
  constructor() {
    super("Capture cursor is invalid");
    this.name = "InvalidCaptureCursorError";
  }
}

function encodeCaptureCursor(value: CaptureCursorValue) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCaptureCursor(cursor: string): CaptureCursorValue {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as CaptureCursorValue).receivedAt !== "string" ||
      typeof (value as CaptureCursorValue).id !== "string"
    ) {
      throw new InvalidCaptureCursorError();
    }
    return value as CaptureCursorValue;
  } catch (error) {
    if (error instanceof InvalidCaptureCursorError) throw error;
    throw new InvalidCaptureCursorError();
  }
}

export function listTextCaptures(
  database: CatchboxDatabase,
  userId: string,
  options: { cursor?: string; limit?: number } = {},
): CaptureListResponse {
  const limit = options.limit ?? 50;
  const cursor = options.cursor ? decodeCaptureCursor(options.cursor) : undefined;
  const beforeCursor = cursor
    ? or(
        lt(schema.captureBatches.receivedAt, cursor.receivedAt),
        and(
          eq(schema.captureBatches.receivedAt, cursor.receivedAt),
          lt(schema.captureItems.id, cursor.id),
        ),
      )
    : undefined;

  const rows = database.orm
    .select({
      id: schema.captureItems.id,
      batchId: schema.captureItems.batchId,
      clientItemId: schema.captureItems.clientItemId,
      type: schema.captureItems.type,
      text: schema.captureItems.textContent,
      state: schema.captureItems.processingState,
      capturedAt: schema.captureBatches.capturedAt,
      receivedAt: schema.captureBatches.receivedAt,
    })
    .from(schema.captureItems)
    .innerJoin(schema.captureBatches, eq(schema.captureItems.batchId, schema.captureBatches.id))
    .where(
      beforeCursor
        ? and(eq(schema.captureItems.userId, userId), beforeCursor)
        : eq(schema.captureItems.userId, userId),
    )
    .orderBy(desc(schema.captureBatches.receivedAt), desc(schema.captureItems.id))
    .limit(limit + 1)
    .all();

  const hasNextPage = rows.length > limit;
  const captures = rows.slice(0, limit);
  const finalCapture = captures.at(-1);

  return {
    captures,
    nextCursor:
      hasNextPage && finalCapture
        ? encodeCaptureCursor({ receivedAt: finalCapture.receivedAt, id: finalCapture.id })
        : null,
  };
}

export { schema };

import type { SessionClientKind } from "@catchbox/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    accountKey: text("account_key").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    sessionVersion: integer("session_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_account_key_unique").on(table.accountKey),
    uniqueIndex("users_username_unique").on(table.username),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientKind: text("client_kind").$type<SessionClientKind>().notNull(),
    sessionVersion: integer("session_version").notNull(),
    idleExpiresAt: text("idle_expires_at").notNull(),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_index").on(table.userId),
    check(
      "sessions_client_kind_check",
      sql`${table.clientKind} in ('browser', 'script', 'android', 'ios')`,
    ),
  ],
);

export const captureBatches = sqliteTable(
  "capture_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientBatchId: text("client_batch_id").notNull(),
    sourcePlatform: text("source_platform"),
    sourceApp: text("source_app"),
    capturedAt: text("captured_at").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    uniqueIndex("capture_batches_user_client_id_unique").on(table.userId, table.clientBatchId),
    index("capture_batches_user_received_index").on(table.userId, table.receivedAt, table.id),
  ],
);

export const captureItems = sqliteTable(
  "capture_items",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => captureBatches.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientItemId: text("client_item_id").notNull(),
    type: text("type").$type<"text">().notNull(),
    textContent: text("text_content").notNull(),
    processingState: text("processing_state").$type<"ready">().notNull(),
    inboxState: text("inbox_state").$type<"inbox">().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("capture_items_user_client_id_unique").on(table.userId, table.clientItemId),
    index("capture_items_batch_id_index").on(table.batchId),
    check("capture_items_type_check", sql`${table.type} = 'text'`),
    check("capture_items_processing_state_check", sql`${table.processingState} = 'ready'`),
    check("capture_items_inbox_state_check", sql`${table.inboxState} = 'inbox'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CaptureBatchRow = typeof captureBatches.$inferSelect;
export type CaptureItemRow = typeof captureItems.$inferSelect;

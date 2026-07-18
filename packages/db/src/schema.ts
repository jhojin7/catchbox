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
    check("sessions_client_kind_check", sql`${table.clientKind} = 'browser'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

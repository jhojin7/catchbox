import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionClientKinds } from "@catchbox/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
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
  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });

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
      "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'sessions')",
    )
    .get() as { value: number };
  const schemaReady = tableCount.value === 2;
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

export function createBrowserSession(
  database: CatchboxDatabase,
  user: schema.UserRow,
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
    clientKind: sessionClientKinds.browser,
    sessionVersion: user.sessionVersion,
    idleExpiresAt: idleExpiresAt.toISOString(),
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    lastUsedAt: now.toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  }).run();

  return { token, absoluteExpiresAt };
}

export function authenticateBrowserSession(
  database: CatchboxDatabase,
  token: string,
  idleSeconds: number,
  now = new Date(),
) {
  const match = database.orm
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSessionToken(token)),
        eq(schema.sessions.clientKind, sessionClientKinds.browser),
        isNull(schema.sessions.revokedAt),
      ),
    )
    .get();

  if (
    !match ||
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

  return match.user;
}

export { schema };

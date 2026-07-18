import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapLocalAccount,
  authenticateBrowserSession,
  countLocalAccounts,
  createBrowserSession,
  findLocalAccountByUsername,
  getDatabaseHealth,
  listTextCaptures,
  openDatabase,
  runMigrations,
  saveTextCaptureBatch,
} from "./index";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isolatedDataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "catchbox-db-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("local account persistence", () => {
  test("migrates an empty WAL database and bootstraps one Argon2id account repeatably", async () => {
    const dataDirectory = isolatedDataDirectory();
    const database = openDatabase(dataDirectory);

    runMigrations(database);
    const first = await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");
    const second = await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");

    expect(getDatabaseHealth(database)).toEqual({
      journalMode: "wal",
      schemaReady: true,
      writable: true,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(countLocalAccounts(database)).toBe(1);
    expect(findLocalAccountByUsername(database, "operator")?.passwordHash).toStartWith(
      "$argon2id$",
    );

    database.close();
  });

  test("opens a copied migrated database with its account and text capture intact", async () => {
    const sourceDirectory = isolatedDataDirectory();
    const source = openDatabase(sourceDirectory);
    runMigrations(source);
    await bootstrapLocalAccount(source, "operator", "a-strong-test-passphrase");
    const sourceAccount = findLocalAccountByUsername(source, "operator")!;
    saveTextCaptureBatch(
      source,
      sourceAccount.id,
      {
        clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
        capturedAt: "2026-07-18T08:15:30.000Z",
        items: [
          {
            clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
            type: "text",
            text: "Preserve this capture",
          },
        ],
      },
      new Date("2026-07-18T08:15:31.000Z"),
    );
    source.close();

    const restoredDirectory = isolatedDataDirectory();
    copyFileSync(join(sourceDirectory, "catchbox.sqlite"), join(restoredDirectory, "catchbox.sqlite"));
    const restored = openDatabase(restoredDirectory);

    expect(getDatabaseHealth(restored)).toEqual({
      journalMode: "wal",
      schemaReady: true,
      writable: true,
    });
    expect(findLocalAccountByUsername(restored, "operator")?.username).toBe("operator");
    expect(listTextCaptures(restored, sourceAccount.id).captures).toEqual([
      {
        id: expect.any(String),
        batchId: expect.any(String),
        clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
        type: "text",
        text: "Preserve this capture",
        state: "ready",
        capturedAt: "2026-07-18T08:15:30.000Z",
        receivedAt: "2026-07-18T08:15:31.000Z",
      },
    ]);

    restored.close();
  });

  test("rejects browser sessions after idle or absolute expiry", async () => {
    const dataDirectory = isolatedDataDirectory();
    const database = openDatabase(dataDirectory);
    runMigrations(database);
    await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");
    const account = findLocalAccountByUsername(database, "operator")!;
    const startedAt = new Date("2026-07-18T00:00:00.000Z");

    const idleSession = createBrowserSession(
      database,
      account,
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      startedAt,
    );
    const absoluteSession = createBrowserSession(
      database,
      account,
      { idleSeconds: 3_600, absoluteSeconds: 60 },
      startedAt,
    );

    expect(
      authenticateBrowserSession(
        database,
        idleSession.token,
        60,
        new Date("2026-07-18T00:01:01.000Z"),
      ),
    ).toBeUndefined();
    expect(
      authenticateBrowserSession(
        database,
        absoluteSession.token,
        3_600,
        new Date("2026-07-18T00:01:01.000Z"),
      ),
    ).toBeUndefined();

    database.close();
  });

  test("reports persistence unavailable when browser-session storage is missing", () => {
    const dataDirectory = isolatedDataDirectory();
    const database = openDatabase(dataDirectory);
    runMigrations(database);
    database.sqlite.exec("DROP TABLE sessions");

    expect(getDatabaseHealth(database)).toEqual({
      journalMode: "wal",
      schemaReady: false,
      writable: false,
    });

    database.close();
  });

  test("rejects session client kinds that are not implemented", async () => {
    const dataDirectory = isolatedDataDirectory();
    const database = openDatabase(dataDirectory);
    runMigrations(database);
    await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");
    const account = findLocalAccountByUsername(database, "operator")!;
    const now = new Date("2026-07-18T00:00:00.000Z").toISOString();

    expect(() =>
      database.sqlite
        .query(
          `INSERT INTO sessions (
            id, token_hash, user_id, client_kind, session_version,
            idle_expires_at, absolute_expires_at, last_used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("session-1", "token-hash", account.id, "native", 1, now, now, now, now),
    ).toThrow();

    database.close();
  });
});

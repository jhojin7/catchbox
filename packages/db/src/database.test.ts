import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatchboxDatabase,
  authenticateCredential,
  bootstrapLocalAccount,
  changeLocalAccountPassword,
  countLocalAccounts,
  createCredential,
  findLocalAccountByUsername,
  getDatabaseHealth,
  listTextCaptures,
  openDatabase,
  revokeCredential,
  runMigrations,
  saveTextCaptureBatch,
  verifyLocalAccountPassword,
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

function applySqlMigration(database: CatchboxDatabase, filename: string) {
  const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) database.sqlite.exec(statement);
  }
}

async function localAccountFixture() {
  const database = openDatabase(isolatedDataDirectory());
  runMigrations(database);
  await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");
  return { database, account: findLocalAccountByUsername(database, "operator")! };
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

  test("upgrades a populated capture database from 0001 and preserves its browser session", async () => {
    const database = openDatabase(isolatedDataDirectory());
    applySqlMigration(database, "0000_orange_sinister_six.sql");
    applySqlMigration(database, "0001_complete_silver_centurion.sql");
    await bootstrapLocalAccount(database, "operator", "a-strong-test-passphrase");
    const account = findLocalAccountByUsername(database, "operator")!;
    const credential = createCredential(
      database,
      account,
      "browser",
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      new Date("2026-07-18T00:00:00.000Z"),
    );
    saveTextCaptureBatch(
      database,
      account.id,
      {
        clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
        capturedAt: "2026-07-18T08:15:30.000Z",
        items: [
          {
            clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
            type: "text",
            text: "Preserve this upgrade",
          },
        ],
      },
      new Date("2026-07-18T08:15:31.000Z"),
    );

    applySqlMigration(database, "0002_sharp_hiroim.sql");

    expect(
      authenticateCredential(
        database,
        credential.token,
        60,
        ["browser"],
        new Date("2026-07-18T00:00:30.000Z"),
      )?.account.id,
    ).toBe(account.id);
    expect(listTextCaptures(database, account.id).captures[0]?.text).toBe(
      "Preserve this upgrade",
    );

    database.close();
  });

  test("rejects credentials after idle or absolute expiry under a controlled clock", async () => {
    const { database, account } = await localAccountFixture();
    const startedAt = new Date("2026-07-18T00:00:00.000Z");

    const idleSession = createCredential(
      database,
      account,
      "browser",
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      startedAt,
    );
    const absoluteSession = createCredential(
      database,
      account,
      "script",
      { idleSeconds: 3_600, absoluteSeconds: 60 },
      startedAt,
    );

    expect(
      authenticateCredential(
        database,
        idleSession.token,
        60,
        ["browser"],
        new Date("2026-07-18T00:01:01.000Z"),
      ),
    ).toBeUndefined();
    expect(
      authenticateCredential(
        database,
        absoluteSession.token,
        3_600,
        ["script"],
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

  test("stores only opaque credential hashes and enforces client kind", async () => {
    const { database, account } = await localAccountFixture();
    const startedAt = new Date("2026-07-18T00:00:00.000Z");
    const credential = createCredential(
      database,
      account,
      "android",
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      startedAt,
    );
    const stored = database.sqlite
      .query("SELECT token_hash, client_kind FROM sessions WHERE user_id = ?")
      .get(account.id) as { token_hash: string; client_kind: string };

    expect(stored).toEqual({
      token_hash: expect.not.stringContaining(credential.token),
      client_kind: "android",
    });
    expect(stored.token_hash).toHaveLength(64);
    expect(
      authenticateCredential(database, credential.token, 60, ["browser"], startedAt),
    ).toBeUndefined();
    expect(
      authenticateCredential(database, credential.token, 60, ["android", "ios"], startedAt)
        ?.account.id,
    ).toBe(account.id);

    database.close();
  });

  test("updates last-used from explicit time, caps idle expiry, and revokes one credential", async () => {
    const { database, account } = await localAccountFixture();
    const credential = createCredential(
      database,
      account,
      "ios",
      { idleSeconds: 80, absoluteSeconds: 100 },
      new Date("2026-07-18T00:00:00.000Z"),
    );

    const authenticated = authenticateCredential(
      database,
      credential.token,
      80,
      ["ios"],
      new Date("2026-07-18T00:00:30.000Z"),
    );
    const stored = database.sqlite
      .query("SELECT last_used_at, idle_expires_at FROM sessions WHERE id = ?")
      .get(authenticated!.credential.id) as { last_used_at: string; idle_expires_at: string };

    expect(stored).toEqual({
      last_used_at: "2026-07-18T00:00:30.000Z",
      idle_expires_at: "2026-07-18T00:01:40.000Z",
    });
    revokeCredential(database, authenticated!.credential.id, new Date("2026-07-18T00:00:31.000Z"));
    expect(
      authenticateCredential(
        database,
        credential.token,
        80,
        ["ios"],
        new Date("2026-07-18T00:00:32.000Z"),
      ),
    ).toBeUndefined();

    database.close();
  });

  test("changes the authenticated account password and invalidates every older credential", async () => {
    const { database, account } = await localAccountFixture();
    const browser = createCredential(
      database,
      account,
      "browser",
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      new Date("2026-07-18T00:00:00.000Z"),
    );
    const script = createCredential(
      database,
      account,
      "script",
      { idleSeconds: 60, absoluteSeconds: 3_600 },
      new Date("2026-07-18T00:00:00.000Z"),
    );

    expect(
      await changeLocalAccountPassword(
        database,
        account.id,
        "wrong-current-password",
        "a-different-strong-passphrase",
        new Date("2026-07-18T00:00:10.000Z"),
      ),
    ).toBe(false);
    expect(
      await changeLocalAccountPassword(
        database,
        account.id,
        "a-strong-test-passphrase",
        "a-different-strong-passphrase",
        new Date("2026-07-18T00:00:20.000Z"),
      ),
    ).toBe(true);

    const changed = findLocalAccountByUsername(database, "operator")!;
    expect(changed.passwordHash).toStartWith("$argon2id$");
    expect(changed.passwordHash).not.toContain("a-different-strong-passphrase");
    expect(changed.sessionVersion).toBe(account.sessionVersion + 1);
    expect(changed.updatedAt).toBe("2026-07-18T00:00:20.000Z");
    expect(
      authenticateCredential(database, browser.token, 60, ["browser"], new Date("2026-07-18T00:00:21.000Z")),
    ).toBeUndefined();
    expect(
      authenticateCredential(database, script.token, 60, ["script"], new Date("2026-07-18T00:00:21.000Z")),
    ).toBeUndefined();

    database.close();
  });

  test("allows only one concurrent password change from the same credential version", async () => {
    const { database, account } = await localAccountFixture();

    const results = await Promise.all([
      changeLocalAccountPassword(
        database,
        account.id,
        "a-strong-test-passphrase",
        "first-concurrent-passphrase",
        new Date("2026-07-18T00:00:20.000Z"),
      ),
      changeLocalAccountPassword(
        database,
        account.id,
        "a-strong-test-passphrase",
        "second-concurrent-passphrase",
        new Date("2026-07-18T00:00:21.000Z"),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(findLocalAccountByUsername(database, "operator")?.sessionVersion).toBe(
      account.sessionVersion + 1,
    );
    const acceptedPasswords = await Promise.all([
      verifyLocalAccountPassword(database, "operator", "first-concurrent-passphrase"),
      verifyLocalAccountPassword(database, "operator", "second-concurrent-passphrase"),
    ]);
    expect(acceptedPasswords.filter(Boolean)).toHaveLength(1);

    database.close();
  });
});

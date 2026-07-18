import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countLocalAccounts, findLocalAccountByUsername, openDatabase } from "./index";

const repositoryRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
let dataDirectory: string | undefined;

afterEach(() => {
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

async function runRootCommand(command: "db:migrate" | "auth:bootstrap") {
  const process = Bun.spawn(["bun", "run", command], {
    cwd: repositoryRoot,
    env: {
      ...Bun.env,
      CATCHBOX_DATA_DIR: dataDirectory,
      CATCHBOX_BOOTSTRAP_USERNAME: "operator",
      CATCHBOX_BOOTSTRAP_PASSWORD: "a-strong-test-passphrase",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("root operator commands", () => {
  test("migrates and repeatably bootstraps the configured local account", async () => {
    dataDirectory = mkdtempSync(join(tmpdir(), "catchbox-operator-test-"));

    expect((await runRootCommand("db:migrate")).exitCode).toBe(0);
    expect((await runRootCommand("auth:bootstrap")).exitCode).toBe(0);
    expect((await runRootCommand("auth:bootstrap")).exitCode).toBe(0);

    const database = openDatabase(dataDirectory);
    expect(countLocalAccounts(database)).toBe(1);
    expect(findLocalAccountByUsername(database, "operator")?.passwordHash).not.toContain(
      "a-strong-test-passphrase",
    );
    database.close();
  });
});

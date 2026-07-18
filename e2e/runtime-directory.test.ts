import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import globalSetup from "./global-setup";
import { createE2eDataDirectoryPath, removeE2eDataDirectory } from "./runtime-directory";

const pendingCleanup = new Set<string>();

afterEach(() => {
  for (const directory of pendingCleanup) {
    if (existsSync(directory)) removeE2eDataDirectory(directory);
  }
  pendingCleanup.clear();
});

describe("browser-test runtime data", () => {
  test("creates a fresh directory per run and removes it after use", () => {
    const first = createE2eDataDirectoryPath();
    const second = createE2eDataDirectoryPath();
    pendingCleanup.add(first);
    pendingCleanup.add(second);

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);

    mkdirSync(first);
    mkdirSync(second);

    removeE2eDataDirectory(first);
    pendingCleanup.delete(first);
    expect(existsSync(first)).toBe(false);
    expect(() => removeE2eDataDirectory(`${second}/../unrelated`)).toThrow(
      "Refusing to remove a directory outside the Catchbox E2E runtime prefix",
    );
  });

  test("captures the configured run directory for lifecycle teardown", async () => {
    const directory = createE2eDataDirectoryPath();
    pendingCleanup.add(directory);
    mkdirSync(directory);
    const previous = process.env.CATCHBOX_E2E_DATA_DIR;
    process.env.CATCHBOX_E2E_DATA_DIR = directory;

    try {
      const teardown = globalSetup();
      delete process.env.CATCHBOX_E2E_DATA_DIR;
      await teardown();
      pendingCleanup.delete(directory);
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CATCHBOX_E2E_DATA_DIR;
      else process.env.CATCHBOX_E2E_DATA_DIR = previous;
    }
  });
});

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const E2E_DIRECTORY_PREFIX = join(tmpdir(), "catchbox-e2e-");

export function createE2eDataDirectoryPath() {
  let directory: string;
  do {
    directory = `${E2E_DIRECTORY_PREFIX}${randomUUID()}`;
  } while (existsSync(directory));
  return directory;
}

export function removeE2eDataDirectory(directory: string) {
  const resolvedDirectory = resolve(directory);
  const directoryName = basename(resolvedDirectory);
  const isE2eDirectory =
    dirname(resolvedDirectory) === resolve(tmpdir()) &&
    /^catchbox-e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      directoryName,
    );
  if (!isE2eDirectory) {
    throw new Error("Refusing to remove a directory outside the Catchbox E2E runtime prefix");
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
}

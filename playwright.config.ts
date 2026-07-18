import { defineConfig } from "@playwright/test";
import { createE2eDataDirectoryPath } from "./e2e/runtime-directory";

const port = 4173;
const dataDir = process.env.CATCHBOX_E2E_DATA_DIR ?? createE2eDataDirectoryPath();
process.env.CATCHBOX_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
  },
  webServer: {
    command: "bun run build && bun run db:migrate && bun run auth:bootstrap && bun run start",
    url: `http://127.0.0.1:${port}/api/v1/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      CATCHBOX_DATA_DIR: dataDir,
      CATCHBOX_BOOTSTRAP_USERNAME: "operator",
      CATCHBOX_BOOTSTRAP_PASSWORD: "a-strong-test-passphrase",
      CATCHBOX_HOST: "127.0.0.1",
      CATCHBOX_PORT: String(port),
      CATCHBOX_SESSION_IDLE_SECONDS: "604800",
      CATCHBOX_SESSION_ABSOLUTE_SECONDS: "2592000",
      CATCHBOX_SECURE_COOKIES: "false",
      NODE_ENV: "development",
    },
  },
});

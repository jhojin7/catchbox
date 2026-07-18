import { describe, expect, test } from "bun:test";
import { loadApiConfig, loadOperatorConfig } from "./index";

const validEnvironment = {
  CATCHBOX_DATA_DIR: "/tmp/catchbox-test-data",
  CATCHBOX_BOOTSTRAP_USERNAME: "operator",
  CATCHBOX_BOOTSTRAP_PASSWORD: "a-strong-test-passphrase",
};

describe("startup configuration", () => {
  test("rejects startup when required configuration is missing or runtime data is relative", () => {
    expect(() => loadApiConfig({})).toThrow("Invalid Catchbox configuration");
    expect(() =>
      loadOperatorConfig({ ...validEnvironment, CATCHBOX_DATA_DIR: "./data" }),
    ).toThrow("Invalid Catchbox configuration");
  });

  test("loads required settings and documented session defaults", () => {
    const config = loadApiConfig(validEnvironment);

    expect(config).toMatchObject({
      dataDir: "/tmp/catchbox-test-data",
      bootstrapUsername: "operator",
      sessionIdleSeconds: 604_800,
      sessionAbsoluteSeconds: 2_592_000,
      host: "127.0.0.1",
      port: 3000,
    });
  });
});

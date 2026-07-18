import { describe, expect, test } from "bun:test";
import {
  currentAccountSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  loginRequestSchema,
  sessionClientKindSchema,
} from "./index";

describe("authentication contracts", () => {
  test("accepts a username and password login payload", () => {
    expect(
      loginRequestSchema.parse({ username: "operator", password: "a strong passphrase" }),
    ).toEqual({ username: "operator", password: "a strong passphrase" });
    expect(
      loginRequestSchema.safeParse({
        username: "operator",
        password: "a strong passphrase",
        sessionKind: "native",
      }).success,
    ).toBe(false);
  });

  test("rejects an error response without a stable code and message", () => {
    expect(errorEnvelopeSchema.safeParse({ error: "bad credentials" }).success).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ code: "MADE_UP_CODE", message: "bad credentials" }).success,
    ).toBe(false);
  });

  test("allows only session client kinds implemented by this slice", () => {
    expect(sessionClientKindSchema.parse("browser")).toBe("browser");
    expect(sessionClientKindSchema.safeParse("native").success).toBe(false);
  });

  test("defines public account and health responses without private fields", () => {
    expect(currentAccountSchema.parse({ id: "user-1", username: "operator" })).toEqual({
      id: "user-1",
      username: "operator",
    });
    expect(healthResponseSchema.parse({ status: "ready" })).toEqual({ status: "ready" });
    expect(
      currentAccountSchema.safeParse({
        id: "user-1",
        username: "operator",
        passwordHash: "secret",
      }).success,
    ).toBe(false);
  });
});

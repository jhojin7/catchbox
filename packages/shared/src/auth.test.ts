import { describe, expect, test } from "bun:test";
import {
  changePasswordRequestSchema,
  currentAccountSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  loginRequestSchema,
  sessionClientKindSchema,
  tokenLoginResponseSchema,
} from "./index";

describe("authentication contracts", () => {
  test("accepts browser and explicit token-client login payloads", () => {
    expect(
      loginRequestSchema.parse({ username: "operator", password: "a strong passphrase" }),
    ).toEqual({ username: "operator", password: "a strong passphrase" });
    expect(loginRequestSchema.parse({
        username: "operator",
        password: "a strong passphrase",
        clientKind: "script",
      })).toEqual({
        username: "operator",
        password: "a strong passphrase",
        clientKind: "script",
      });
    expect(loginRequestSchema.safeParse({
      username: "operator",
      password: "a strong passphrase",
      clientKind: "native",
    }).success).toBe(false);
  });

  test("rejects an error response without a stable code and message", () => {
    expect(errorEnvelopeSchema.safeParse({ error: "bad credentials" }).success).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ code: "MADE_UP_CODE", message: "bad credentials" }).success,
    ).toBe(false);
  });

  test("defines browser and supported opaque-token client kinds", () => {
    expect(sessionClientKindSchema.parse("browser")).toBe("browser");
    expect(sessionClientKindSchema.parse("script")).toBe("script");
    expect(sessionClientKindSchema.parse("android")).toBe("android");
    expect(sessionClientKindSchema.parse("ios")).toBe("ios");
    expect(sessionClientKindSchema.safeParse("native").success).toBe(false);
  });

  test("keeps token login and password-change payloads strict", () => {
    expect(
      tokenLoginResponseSchema.parse({
        account: { id: "user-1", username: "operator" },
        token: "opaque-token",
        tokenType: "Bearer",
        expiresAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toEqual({
      account: { id: "user-1", username: "operator" },
      token: "opaque-token",
      tokenType: "Bearer",
      expiresAt: "2026-08-18T00:00:00.000Z",
    });
    expect(
      changePasswordRequestSchema.parse({
        currentPassword: "a-strong-test-passphrase",
        newPassword: "a-different-strong-passphrase",
      }),
    ).toEqual({
      currentPassword: "a-strong-test-passphrase",
      newPassword: "a-different-strong-passphrase",
    });
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: "a-strong-test-passphrase",
        newPassword: "short",
        userId: "somebody-else",
      }).success,
    ).toBe(false);
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

import { describe, expect, test } from "bun:test";
import { fetchCurrentAccount, loginWithPassword } from "./auth-api";

function responseWith(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("browser authentication API", () => {
  test("parses current-account and expected unauthenticated responses", async () => {
    await expect(
      fetchCurrentAccount(responseWith({ id: "user-1", username: "operator" })),
    ).resolves.toEqual({ id: "user-1", username: "operator" });
    await expect(
      fetchCurrentAccount(
        responseWith(
          { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue" },
          401,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects malformed current-account and error responses safely", async () => {
    await expect(
      fetchCurrentAccount(responseWith({ username: "operator", passwordHash: "private" })),
    ).rejects.toThrow("Catchbox returned an invalid response");
    await expect(
      fetchCurrentAccount(responseWith({ code: "UNKNOWN", message: "no" }, 401)),
    ).rejects.toThrow("Catchbox returned an invalid response");
  });

  test("parses login success and presents only validated server errors", async () => {
    await expect(
      loginWithPassword(
        { username: "operator", password: "a-strong-test-passphrase" },
        responseWith({ id: "user-1", username: "operator" }),
      ),
    ).resolves.toEqual({ id: "user-1", username: "operator" });
    await expect(
      loginWithPassword(
        { username: "operator", password: "wrong-password" },
        responseWith(
          { code: "INVALID_CREDENTIALS", message: "Username or password is incorrect" },
          401,
        ),
      ),
    ).rejects.toThrow("Username or password is incorrect");
    await expect(
      loginWithPassword(
        { username: "operator", password: "wrong-password" },
        responseWith({ code: "UNKNOWN", message: "untrusted" }, 500),
      ),
    ).rejects.toThrow("Catchbox returned an invalid response");
  });
});

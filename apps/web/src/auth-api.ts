import {
  currentAccountSchema,
  errorEnvelopeSchema,
  loginRequestSchema,
  type CurrentAccount,
  type ErrorCode,
  type LoginRequest,
} from "@catchbox/shared";
import {
  readValidatedJson,
  throwApiError,
  throwValidatedApiError,
  type HttpFetcher,
} from "./http-api";

export class AuthenticationApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "AuthenticationApiError";
  }
}

export async function fetchCurrentAccount(
  fetcher: HttpFetcher = fetch,
): Promise<CurrentAccount | undefined> {
  const response = await fetcher("/api/v1/auth/me", {
    headers: { accept: "application/json" },
  });
  if (response.ok) return readValidatedJson(response, currentAccountSchema);

  const error = await readValidatedJson(response, errorEnvelopeSchema);
  if (response.status === 401 && error.code === "AUTHENTICATION_REQUIRED") return undefined;
  return throwApiError(
    error,
    (message, code) => new AuthenticationApiError(message, code),
  );
}

export async function loginWithPassword(
  credentials: LoginRequest,
  fetcher: HttpFetcher = fetch,
): Promise<CurrentAccount> {
  const request = loginRequestSchema.parse(credentials);
  const response = await fetcher("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) return readValidatedJson(response, currentAccountSchema);

  return throwValidatedApiError(
    response,
    (message, code) => new AuthenticationApiError(message, code),
  );
}

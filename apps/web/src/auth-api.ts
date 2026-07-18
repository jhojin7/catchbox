import {
  currentAccountSchema,
  errorEnvelopeSchema,
  loginRequestSchema,
  type CurrentAccount,
  type ErrorCode,
  type LoginRequest,
} from "@catchbox/shared";

const INVALID_RESPONSE_MESSAGE = "Catchbox returned an invalid response";
type AuthenticationFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class AuthenticationApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "AuthenticationApiError";
  }
}

async function readCurrentAccount(response: Response) {
  try {
    return currentAccountSchema.parse(await response.json());
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
}

async function readError(response: Response) {
  try {
    return errorEnvelopeSchema.parse(await response.json());
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
}

export async function fetchCurrentAccount(
  fetcher: AuthenticationFetcher = fetch,
): Promise<CurrentAccount | undefined> {
  const response = await fetcher("/api/v1/auth/me", {
    headers: { accept: "application/json" },
  });
  if (response.ok) return readCurrentAccount(response);

  const error = await readError(response);
  if (response.status === 401 && error.code === "AUTHENTICATION_REQUIRED") return undefined;
  throw new AuthenticationApiError(error.message, error.code);
}

export async function loginWithPassword(
  credentials: LoginRequest,
  fetcher: AuthenticationFetcher = fetch,
): Promise<CurrentAccount> {
  const request = loginRequestSchema.parse(credentials);
  const response = await fetcher("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) return readCurrentAccount(response);

  const error = await readError(response);
  throw new AuthenticationApiError(error.message, error.code);
}

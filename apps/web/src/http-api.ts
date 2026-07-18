import { errorEnvelopeSchema, type ErrorCode, type ErrorEnvelope } from "@catchbox/shared";

const INVALID_RESPONSE_MESSAGE = "Catchbox returned an invalid response";

export type HttpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ResponseSchema<Output> {
  parse(value: unknown): Output;
}

export async function readValidatedJson<Output>(
  response: Response,
  schema: ResponseSchema<Output>,
) {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
}

export async function throwValidatedApiError(
  response: Response,
  createError: (message: string, code: ErrorCode) => Error,
): Promise<never> {
  const error = await readValidatedJson(response, errorEnvelopeSchema);
  return throwApiError(error, createError);
}

export function throwApiError(
  error: ErrorEnvelope,
  createError: (message: string, code: ErrorCode) => Error,
): never {
  throw createError(error.message, error.code);
}

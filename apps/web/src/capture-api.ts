import {
  captureBatchRequestSchema,
  captureBatchResponseSchema,
  captureListResponseSchema,
  outboxStatusRequestSchema,
  outboxStatusResponseSchema,
  outboxRetryRequestSchema,
  type CaptureBatchRequest,
  type CaptureBatchResponse,
  type CaptureListResponse,
  type ErrorCode,
  type OutboxStatusRequest,
  type OutboxStatusResponse,
  type OutboxRetryRequest,
} from "@catchbox/shared";
import { readValidatedJson, throwValidatedApiError, type HttpFetcher } from "./http-api";

export class CaptureApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "CaptureApiError";
  }
}

export async function submitTextCapture(
  input: CaptureBatchRequest,
  fetcher: HttpFetcher = fetch,
): Promise<CaptureBatchResponse> {
  const request = captureBatchRequestSchema.parse(input);
  const response = await fetcher("/api/v1/capture-batches", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    return throwValidatedApiError(
      response,
      (message, code) => new CaptureApiError(message, code),
    );
  }
  return readValidatedJson(response, captureBatchResponseSchema);
}

export async function fetchCaptureInbox(
  fetcher: HttpFetcher = fetch,
  cursor?: string,
): Promise<CaptureListResponse> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetcher(`/api/v1/captures${query}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    return throwValidatedApiError(
      response,
      (message, code) => new CaptureApiError(message, code),
    );
  }
  return readValidatedJson(response, captureListResponseSchema);
}

export async function reconcileOutbox(
  input: OutboxStatusRequest,
  fetcher: HttpFetcher = fetch,
): Promise<OutboxStatusResponse> {
  const request = outboxStatusRequestSchema.parse(input);
  const response = await fetcher("/api/v1/outbox/status", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    return throwValidatedApiError(
      response,
      (message, code) => new CaptureApiError(message, code),
    );
  }
  return readValidatedJson(response, outboxStatusResponseSchema);
}

export async function retryOutboxItems(
  input: OutboxRetryRequest,
  fetcher: HttpFetcher = fetch,
): Promise<CaptureBatchResponse> {
  const request = outboxRetryRequestSchema.parse(input);
  const response = await fetcher("/api/v1/outbox/retry-items", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    return throwValidatedApiError(
      response,
      (message, code) => new CaptureApiError(message, code),
    );
  }
  return readValidatedJson(response, captureBatchResponseSchema);
}

import { describe, expect, test } from "bun:test";
import {
  captureBatchRequestSchema,
  captureBatchResponseSchema,
  captureCursorSchema,
  captureListQuerySchema,
  captureListResponseSchema,
  outboxStatusRequestSchema,
  outboxStatusResponseSchema,
  outboxRetryRequestSchema,
  type CaptureBatchRequest,
  type CaptureBatchResponse,
  type CaptureListResponse,
  type OutboxStatusResponse,
} from "./index";

const batchId = "79d34d4b-662f-4d7b-95bc-a2cb509872a8";
const itemId = "f427a1f5-c2e3-4cd9-b9b0-64585fac9206";

describe("text capture contracts", () => {
  test("accepts bounded identified text items and rejects duplicate or unsupported input", () => {
    const request: CaptureBatchRequest = {
      clientBatchId: batchId,
      capturedAt: "2026-07-18T08:15:30.000Z",
      source: { platform: "script", app: "daily-notes" },
      items: [{ clientItemId: itemId, type: "text", text: "Remember the adapter" }],
    };

    expect(captureBatchRequestSchema.parse(request)).toEqual(request);
    expect(
      captureBatchRequestSchema.safeParse({
        ...request,
        items: [...request.items, { ...request.items[0] }],
      }).success,
    ).toBe(false);
    expect(
      captureBatchRequestSchema.safeParse({
        ...request,
        items: [...request.items, { ...request.items[0], clientItemId: crypto.randomUUID() }],
      }).success,
    ).toBe(true);
    expect(
      captureBatchRequestSchema.safeParse({
        ...request,
        items: [{ ...request.items[0], type: "url", url: "https://example.com" }],
      }).success,
    ).toBe(false);
    expect(captureBatchRequestSchema.safeParse({ ...request, serverOnly: true }).success).toBe(false);
  });

  test("defines explicit batch and per-item outcomes without persistence fields", () => {
    const response: CaptureBatchResponse = {
      batch: {
        id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
        clientBatchId: batchId,
        result: "created",
        capturedAt: "2026-07-18T08:15:30.000Z",
        receivedAt: "2026-07-18T08:15:31.000Z",
      },
      items: [
        {
          id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
          clientItemId: itemId,
          result: "created",
          type: "text",
          state: "ready",
        },
      ],
    };

    expect(captureBatchResponseSchema.parse(response)).toEqual(response);
    expect(
      captureBatchResponseSchema.safeParse({
        ...response,
        items: [{ ...response.items[0], userId: "private-user-id" }],
      }).success,
    ).toBe(false);
  });

  test("defines an opaque cursor and deterministic chronological capture page", () => {
    const page: CaptureListResponse = {
      captures: [
        {
          id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
          batchId: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
          clientItemId: itemId,
          type: "text",
          text: "Remember the adapter",
          state: "ready",
          capturedAt: "2026-07-18T08:15:30.000Z",
          receivedAt: "2026-07-18T08:15:31.000Z",
        },
      ],
      nextCursor: "eyJyZWNlaXZlZEF0IjoiMjAyNi0wNy0xOFQwODoxNTozMS4wMDBaIiwiaWQiOiJpLTEifQ",
    };

    expect(captureListResponseSchema.parse(page)).toEqual(page);
    expect(captureCursorSchema.parse(page.nextCursor!)).toBe(page.nextCursor!);
    expect(captureCursorSchema.safeParse("not an opaque cursor!").success).toBe(false);
  });

  test("validates and converts the chronological listing query at the HTTP boundary", () => {
    const cursor = "eyJyZWNlaXZlZEF0IjoiMjAyNi0wNy0xOFQwODoxNTozMS4wMDBaIiwiaWQiOiJpLTEifQ";

    expect(captureListQuerySchema.parse({ cursor, limit: "50" })).toEqual({
      cursor,
      limit: 50,
    });
    expect(captureListQuerySchema.parse({})).toEqual({});
    expect(captureListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(captureListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(captureListQuerySchema.safeParse({ cursor: "invalid cursor" }).success).toBe(false);
    expect(captureListQuerySchema.safeParse({ state: "inbox" }).success).toBe(false);
  });

  test("defines reconciliation by stable batch and item identities", () => {
    const request = {
      clientBatchIds: [batchId],
      clientItemIds: [itemId],
    };
    const response: OutboxStatusResponse = {
      batches: [
        {
          id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
          clientBatchId: batchId,
          capturedAt: "2026-07-18T08:15:30.000Z",
          receivedAt: "2026-07-18T08:15:31.000Z",
          items: [
            {
              id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
              clientItemId: itemId,
              type: "text",
              state: "ready",
            },
          ],
        },
      ],
    };

    expect(outboxStatusRequestSchema.parse(request)).toEqual(request);
    expect(outboxStatusResponseSchema.parse(response)).toEqual(response);
    expect(
      outboxStatusRequestSchema.safeParse({ clientBatchIds: [], clientItemIds: [] }).success,
    ).toBe(false);
    expect(
      outboxStatusRequestSchema.safeParse({
        clientBatchIds: Array.from({ length: 101 }, () => batchId),
        clientItemIds: [],
      }).success,
    ).toBe(false);
  });

  test("limits an item retry to unique stable members of its retained batch", () => {
    const batch: CaptureBatchRequest = {
      clientBatchId: batchId,
      capturedAt: "2026-07-18T08:15:30.000Z",
      items: [{ clientItemId: itemId, type: "text", text: "Retry only this item" }],
    };

    expect(outboxRetryRequestSchema.parse({ batch, clientItemIds: [itemId] })).toEqual({
      batch,
      clientItemIds: [itemId],
    });
    expect(
      outboxRetryRequestSchema.safeParse({ batch, clientItemIds: [crypto.randomUUID()] }).success,
    ).toBe(false);
    expect(
      outboxRetryRequestSchema.safeParse({ batch, clientItemIds: [itemId, itemId] }).success,
    ).toBe(false);
  });
});

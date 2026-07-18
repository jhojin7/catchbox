import { describe, expect, test } from "bun:test";
import type { CaptureBatchRequest } from "@catchbox/shared";
import {
  CaptureApiError,
  fetchCaptureInbox,
  reconcileOutbox,
  retryOutboxItems,
  submitTextCapture,
} from "./capture-api";

const request: CaptureBatchRequest = {
  clientBatchId: "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
  capturedAt: "2026-07-18T08:15:30.000Z",
  source: { platform: "web", app: "catchbox-pwa" },
  items: [
    {
      clientItemId: "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
      type: "text",
      text: "Remember the adapter",
    },
  ],
};

describe("browser capture API", () => {
  test("submits and validates one identified text batch", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await submitTextCapture(request, async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(
        JSON.stringify({
          batch: {
            id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
            clientBatchId: request.clientBatchId,
            result: "created",
            capturedAt: request.capturedAt,
            receivedAt: "2026-07-18T08:15:31.000Z",
          },
          items: [
            {
              id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
              clientItemId: request.items[0].clientItemId,
              result: "created",
              type: "text",
              state: "ready",
            },
          ],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    expect(requestedUrl).toBe("/api/v1/capture-batches");
    expect(requestedInit).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(requestedInit?.body))).toEqual(request);
    expect(result.items[0]).toMatchObject({ result: "created", state: "ready" });
  });

  test("loads only validated inbox data and presents validated errors", async () => {
    const inbox = await fetchCaptureInbox(async () =>
      new Response(JSON.stringify({ captures: [], nextCursor: null }), { status: 200 }),
    );
    expect(inbox).toEqual({ captures: [], nextCursor: null });

    const invalidCapture = await submitTextCapture(
      request,
      async () =>
        new Response(
          JSON.stringify({ code: "INVALID_REQUEST", message: "Capture batch request is invalid" }),
          { status: 400 },
        ),
    ).catch((error: unknown) => error);
    expect(invalidCapture).toBeInstanceOf(CaptureApiError);
    expect(invalidCapture).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Capture batch request is invalid",
    });
    await expect(
      fetchCaptureInbox(async () => new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    ).rejects.toThrow("Catchbox returned an invalid response");
  });

  test("reconciles stable client identities through the authenticated status endpoint", async () => {
    let requestedUrl = "";
    let requestedBody: unknown;
    const result = await reconcileOutbox(
      {
        clientBatchIds: [request.clientBatchId],
        clientItemIds: [request.items[0].clientItemId],
      },
      async (url, init) => {
        requestedUrl = url;
        requestedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ batches: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    expect(requestedUrl).toBe("/api/v1/outbox/status");
    expect(requestedBody).toEqual({
      clientBatchIds: [request.clientBatchId],
      clientItemIds: [request.items[0].clientItemId],
    });
    expect(result).toEqual({ batches: [] });
  });

  test("retries only selected stable members through the authenticated outbox endpoint", async () => {
    let requestedUrl = "";
    await retryOutboxItems(
      { batch: request, clientItemIds: [request.items[0].clientItemId] },
      async (url) => {
        requestedUrl = url;
        return new Response(
          JSON.stringify({
            batch: {
              id: "33128080-cf27-4517-a3fa-c8ce1895a8c8",
              clientBatchId: request.clientBatchId,
              result: "created",
              capturedAt: request.capturedAt,
              receivedAt: "2026-07-18T08:15:31.000Z",
            },
            items: [
              {
                id: "25b9d4c4-801a-4707-9072-d5920be3c44e",
                clientItemId: request.items[0].clientItemId,
                result: "created",
                type: "text",
                state: "ready",
              },
            ],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    );
    expect(requestedUrl).toBe("/api/v1/outbox/retry-items");
  });
});

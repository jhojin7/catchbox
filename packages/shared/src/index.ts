import { z } from "zod";

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
    clientKind: z.enum(["script", "android", "ios"]).optional(),
  })
  .strict();

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12),
  })
  .strict();

export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CREDENTIALS",
  "AUTHENTICATION_REQUIRED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
]);

export const errorEnvelopeSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();

export const currentAccountSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
  })
  .strict();

export const tokenLoginResponseSchema = z
  .object({
    account: currentAccountSchema,
    token: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.enum(["live", "ready", "not_ready"]),
  })
  .strict();

export const sessionClientKindSchema = z.enum(["browser", "script", "android", "ios"]);
export const sessionClientKinds = sessionClientKindSchema.enum;

export const captureCursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const captureListQuerySchema = z
  .object({
    cursor: captureCursorSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9]\d|100)$/)
      .transform(Number)
      .optional(),
  })
  .strict();

export const textCaptureItemRequestSchema = z
  .object({
    clientItemId: z.uuid(),
    type: z.literal("text"),
    text: z.string().trim().min(1).max(50_000),
  })
  .strict();

export const captureBatchRequestSchema = z
  .object({
    clientBatchId: z.uuid(),
    capturedAt: z.iso.datetime({ offset: true }),
    source: z
      .object({
        platform: z.string().trim().min(1).max(100).optional(),
        app: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    items: z.array(textCaptureItemRequestSchema).min(1).max(100),
  })
  .strict()
  .superRefine(({ items }, context) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.clientItemId)) {
        context.addIssue({
          code: "custom",
          message: "Client item IDs must be unique within a batch",
          path: ["items"],
        });
      }
      seen.add(item.clientItemId);
    }
  });

export const captureWriteResultSchema = z.enum(["created", "existing"]);
export const captureItemStateSchema = z.literal("ready");

export const captureBatchResponseSchema = z
  .object({
    batch: z
      .object({
        id: z.uuid(),
        clientBatchId: z.uuid(),
        result: captureWriteResultSchema,
        capturedAt: z.iso.datetime({ offset: true }),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    items: z.array(
      z
        .object({
          id: z.uuid(),
          clientItemId: z.uuid(),
          result: captureWriteResultSchema,
          type: z.literal("text"),
          state: captureItemStateSchema,
        })
        .strict(),
    ).min(1).max(100),
  })
  .strict();

export const captureListItemSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    clientItemId: z.uuid(),
    type: z.literal("text"),
    text: z.string(),
    state: captureItemStateSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const captureListResponseSchema = z
  .object({
    captures: z.array(captureListItemSchema),
    nextCursor: captureCursorSchema.nullable(),
  })
  .strict();

export const outboxStatusRequestSchema = z
  .object({
    clientBatchIds: z.array(z.uuid()).max(100),
    clientItemIds: z.array(z.uuid()).max(100),
  })
  .strict()
  .refine(
    ({ clientBatchIds, clientItemIds }) => clientBatchIds.length + clientItemIds.length > 0,
    { message: "At least one client identity is required" },
  );

export const outboxRetryRequestSchema = z
  .object({
    batch: captureBatchRequestSchema,
    clientItemIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict()
  .superRefine(({ batch, clientItemIds }, context) => {
    const requestIds = new Set(batch.items.map((item) => item.clientItemId));
    const selectedIds = new Set<string>();
    for (const clientItemId of clientItemIds) {
      if (!requestIds.has(clientItemId) || selectedIds.has(clientItemId)) {
        context.addIssue({
          code: "custom",
          message: "Retry item IDs must be unique members of the batch request",
          path: ["clientItemIds"],
        });
      }
      selectedIds.add(clientItemId);
    }
  });

const reconciledCaptureItemSchema = z
  .object({
    id: z.uuid(),
    clientItemId: z.uuid(),
    type: z.literal("text"),
    state: captureItemStateSchema,
  })
  .strict();

export const outboxStatusResponseSchema = z
  .object({
    batches: z.array(
      z
        .object({
          id: z.uuid(),
          clientBatchId: z.uuid(),
          capturedAt: z.iso.datetime({ offset: true }),
          receivedAt: z.iso.datetime({ offset: true }),
          items: z.array(reconciledCaptureItemSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type CurrentAccount = z.infer<typeof currentAccountSchema>;
export type TokenLoginResponse = z.infer<typeof tokenLoginResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type SessionClientKind = z.infer<typeof sessionClientKindSchema>;
export type CaptureCursor = z.infer<typeof captureCursorSchema>;
export type CaptureListQuery = z.infer<typeof captureListQuerySchema>;
export type TextCaptureItemRequest = z.infer<typeof textCaptureItemRequestSchema>;
export type CaptureBatchRequest = z.infer<typeof captureBatchRequestSchema>;
export type CaptureWriteResult = z.infer<typeof captureWriteResultSchema>;
export type CaptureBatchResponse = z.infer<typeof captureBatchResponseSchema>;
export type CaptureListItem = z.infer<typeof captureListItemSchema>;
export type CaptureListResponse = z.infer<typeof captureListResponseSchema>;
export type OutboxStatusRequest = z.infer<typeof outboxStatusRequestSchema>;
export type OutboxStatusResponse = z.infer<typeof outboxStatusResponseSchema>;
export type OutboxRetryRequest = z.infer<typeof outboxRetryRequestSchema>;

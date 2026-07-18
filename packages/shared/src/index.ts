import { z } from "zod";

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
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

export const healthResponseSchema = z
  .object({
    status: z.enum(["live", "ready", "not_ready"]),
  })
  .strict();

export const sessionClientKindSchema = z.enum(["browser"]);
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
    items: z.tuple([textCaptureItemRequestSchema]),
  })
  .strict();

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
    items: z.tuple([
      z
        .object({
          id: z.uuid(),
          clientItemId: z.uuid(),
          result: captureWriteResultSchema,
          type: z.literal("text"),
          state: captureItemStateSchema,
        })
        .strict(),
    ]),
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

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type CurrentAccount = z.infer<typeof currentAccountSchema>;
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

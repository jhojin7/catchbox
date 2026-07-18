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

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type CurrentAccount = z.infer<typeof currentAccountSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type SessionClientKind = z.infer<typeof sessionClientKindSchema>;

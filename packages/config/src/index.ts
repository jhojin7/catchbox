import { isAbsolute } from "node:path";
import { z } from "zod";

const dataDirectory = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "must be an absolute path");
const positiveInteger = z.coerce.number().int().positive();

const operatorEnvironmentSchema = z.object({
  CATCHBOX_DATA_DIR: dataDirectory,
  CATCHBOX_BOOTSTRAP_USERNAME: z.string().trim().min(1),
  CATCHBOX_BOOTSTRAP_PASSWORD: z.string().min(12),
});

const apiEnvironmentSchema = operatorEnvironmentSchema.extend({
  CATCHBOX_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CATCHBOX_PORT: positiveInteger.max(65_535).default(3000),
  CATCHBOX_SESSION_IDLE_SECONDS: positiveInteger.default(604_800),
  CATCHBOX_SESSION_ABSOLUTE_SECONDS: positiveInteger.default(2_592_000),
  CATCHBOX_SECURE_COOKIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

function parseEnvironment<Schema extends z.ZodType>(
  schema: Schema,
  environment: Record<string, string | undefined>,
): z.output<Schema> {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const fields = Object.keys(z.flattenError(result.error).fieldErrors).join(", ");
    throw new Error(`Invalid Catchbox configuration: ${fields}`);
  }
  return result.data;
}

function operatorConfig(parsed: z.infer<typeof operatorEnvironmentSchema>) {
  return {
    dataDir: parsed.CATCHBOX_DATA_DIR,
    bootstrapUsername: parsed.CATCHBOX_BOOTSTRAP_USERNAME,
    bootstrapPassword: parsed.CATCHBOX_BOOTSTRAP_PASSWORD,
  };
}

export function loadOperatorConfig(environment: Record<string, string | undefined>) {
  return operatorConfig(parseEnvironment(operatorEnvironmentSchema, environment));
}

export function loadApiConfig(environment: Record<string, string | undefined>) {
  const parsed = parseEnvironment(apiEnvironmentSchema, environment);
  if (parsed.CATCHBOX_SESSION_IDLE_SECONDS > parsed.CATCHBOX_SESSION_ABSOLUTE_SECONDS) {
    throw new Error(
      "Invalid Catchbox configuration: CATCHBOX_SESSION_IDLE_SECONDS must not exceed CATCHBOX_SESSION_ABSOLUTE_SECONDS",
    );
  }

  return {
    ...operatorConfig(parsed),
    host: parsed.CATCHBOX_HOST,
    port: parsed.CATCHBOX_PORT,
    sessionIdleSeconds: parsed.CATCHBOX_SESSION_IDLE_SECONDS,
    sessionAbsoluteSeconds: parsed.CATCHBOX_SESSION_ABSOLUTE_SECONDS,
    secureCookies: parsed.CATCHBOX_SECURE_COOKIES,
    environment: parsed.NODE_ENV,
  };
}

export type CatchboxConfig = ReturnType<typeof loadApiConfig>;

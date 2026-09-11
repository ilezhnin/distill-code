import { z } from "zod/v4";

function nonEmptyString(field: string) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, `${field} must not be empty`);
}

export const runtimeIdentitySchema = z
  .object({
    id: nonEmptyString("identity id"),
    displayName: nonEmptyString("identity displayName").optional(),
  })
  .strict();

export const runtimeDoctorConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    internalToolingChecks: z.boolean().optional(),
  })
  .strict();

export const runtimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    customer: runtimeIdentitySchema.optional(),
    workspace: runtimeIdentitySchema.optional(),
    featureToggles: z
      .record(nonEmptyString("featureToggles keys"), z.boolean())
      .optional(),
    doctor: runtimeDoctorConfigSchema.optional(),
  })
  .strict();

export const runtimeConfigSourceSchema = z.enum([
  "appDefault",
  "bundledFile",
  "fakeEndpoint",
]);

export const runtimeConfigUnavailableReasonSchema = z.enum([
  "invalid",
  "missing",
  "readFailed",
  "unsupportedBuild",
]);

export const runtimeConfigLoadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      source: runtimeConfigSourceSchema,
      config: runtimeConfigSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      source: runtimeConfigSourceSchema,
      reason: runtimeConfigUnavailableReasonSchema,
      message: z.string(),
    })
    .strict(),
]);

export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export type RuntimeDoctorConfig = z.infer<typeof runtimeDoctorConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RuntimeConfigSource = z.infer<typeof runtimeConfigSourceSchema>;
export type RuntimeConfigUnavailableReason = z.infer<
  typeof runtimeConfigUnavailableReasonSchema
>;
export type RuntimeConfigLoadResult = z.infer<
  typeof runtimeConfigLoadResultSchema
>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  schemaVersion: 1,
};

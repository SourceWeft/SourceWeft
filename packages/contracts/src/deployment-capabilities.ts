import { z } from "zod";
import { billingModeSchema, billingProviderSchema } from "./billing";

export const deploymentCapabilitiesSchema = z.discriminatedUnion("edition", [
  z.object({
    edition: z.literal("core"),
    billingRuntimeApiVersion: z.literal(1),
    billing: z.object({
      available: z.literal(false),
      mode: z.null(),
      checkout: z.literal(false),
      teamSubscriptions: z.literal(false),
      topup: z.literal(false),
    }),
  }),
  z.object({
    edition: z.literal("commercial"),
    billingRuntimeApiVersion: z.literal(1),
    billing: z.object({
      available: z.literal(true),
      provider: billingProviderSchema.optional(),
      paymentEnvironment: z.enum(["test", "prod"]).optional(),
      mode: billingModeSchema,
      checkout: z.boolean(),
      teamSubscriptions: z.boolean(),
      topup: z.boolean(),
    }),
  }),
]);

export type DeploymentCapabilities = z.infer<
  typeof deploymentCapabilitiesSchema
>;

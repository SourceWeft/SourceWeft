"use client";
import { creemClient } from "@creem_io/better-auth/client";
export const billingAuthClientPlugins: ReturnType<typeof creemClient>[] = [
  creemClient(),
];

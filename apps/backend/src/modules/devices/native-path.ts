import { z } from "zod";

// Device paths use forward slashes, even when the backend runs on Linux and
// the device runs on Windows. Never resolve them using the backend's OS.
export function isNativeAbsolutePath(value: string): boolean {
  return (
    !/[\x00-\x1f\x7f\\]/u.test(value) &&
    (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

export const nativeAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    isNativeAbsolutePath,
    "Expected an absolute device path with forward slashes",
  );

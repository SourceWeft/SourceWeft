/** Preserve Error details when Better Auth passes an error as a logger argument. */
export function serializeAuthLogArgs(args: unknown[]): unknown[] {
  return args.map((arg) =>
    arg instanceof Error
      ? { name: arg.name, message: arg.message, stack: arg.stack }
      : arg,
  );
}

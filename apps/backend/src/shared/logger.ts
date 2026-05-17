type Meta = Record<string, unknown> | undefined;

function serializeMeta(meta: Meta) {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(meta, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        return value.toString();
      }

      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }

      return value;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ loggerMetaSerializationError: message });
  }
}

function write(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Meta,
) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] ${message}`;
  if (meta) {
    if (process.env.NODE_ENV === "production") {
      console.log(`${prefix} ${serializeMeta(meta)}`);
      return;
    }

    console.log(prefix, meta);
    return;
  }
  console.log(prefix);
}

export const logger = {
  debug: (message: string, meta?: Meta) => write("DEBUG", message, meta),
  info: (message: string, meta?: Meta) => write("INFO", message, meta),
  warn: (message: string, meta?: Meta) => write("WARN", message, meta),
  error: (message: string, meta?: Meta) => write("ERROR", message, meta),
};

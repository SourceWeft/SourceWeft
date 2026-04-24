type Meta = Record<string, unknown> | undefined;

function write(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Meta,
) {
  const ts = new Date().toISOString();
  if (meta) {
    console.log(`[${ts}] [${level}] ${message}`, meta);
    return;
  }
  console.log(`[${ts}] [${level}] ${message}`);
}

export const logger = {
  debug: (message: string, meta?: Meta) => write("DEBUG", message, meta),
  info: (message: string, meta?: Meta) => write("INFO", message, meta),
  warn: (message: string, meta?: Meta) => write("WARN", message, meta),
  error: (message: string, meta?: Meta) => write("ERROR", message, meta),
};

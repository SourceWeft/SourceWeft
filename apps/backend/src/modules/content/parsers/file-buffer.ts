import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sanitizeExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? ".bin";
}

export async function withTempFile<T>(input: {
  fileName: string;
  content: Buffer;
  run: (filePath: string) => Promise<T>;
}) {
  const dir = join(tmpdir(), "sourceweft-content");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${randomUUID()}${sanitizeExtension(input.fileName)}`);
  await writeFile(filePath, input.content);

  try {
    return await input.run(filePath);
  } finally {
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}

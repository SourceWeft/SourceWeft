import sharp from "sharp";

export async function normalizeImageForPdf2Markdown(input: {
  content: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<{
  content: Buffer;
  fileName: string;
  mimeType: string;
  originalMimeType?: string;
  originalFileName?: string;
}> {
  if (input.mimeType !== "image/avif") {
    return input;
  }

  const content = await sharp(input.content).png().toBuffer();
  const fileName = input.fileName.replace(/\.[^.]+$/, "") || "image";

  return {
    content,
    fileName: `${fileName}.png`,
    mimeType: "image/png",
    originalMimeType: input.mimeType,
    originalFileName: input.fileName,
  };
}

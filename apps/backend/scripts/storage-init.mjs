import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
const bucket = process.env.S3_BUCKET;
if (!bucket) throw new Error("S3_BUCKET is required");
const client = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials:
    (process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID) &&
    (process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY)
      ? {
          accessKeyId:
            process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
          secretAccessKey:
            process.env.AWS_SECRET_ACCESS_KEY ||
            process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
});
for (let attempt = 0; ; attempt++) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(5000),
    });
    break;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) {
      if (process.env.S3_CREATE_BUCKET !== "true")
        throw new Error(
          "Configured S3 bucket does not exist; set S3_CREATE_BUCKET=true to authorize creation.",
        );
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (cause) {
        if (cause.name === "BucketAlreadyOwnedByYou") break;
        throw cause;
      }
    }
    // Retry only transport/unavailable responses while the selected service starts.
    if (
      (error.$metadata?.httpStatusCode &&
        error.$metadata.httpStatusCode < 500) ||
      attempt >= 29
    )
      throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
client.destroy();
console.log("Source storage bucket is ready.");

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
const directory = process.argv[2] || "/config";
let text = readFileSync(join(directory, ".env.example"), "utf8");
for (const name of [
  "DB_PASSWORD",
  "S3_SECRET_ACCESS_KEY",
  "BETTER_AUTH_SECRET",
  "MODEL_GATEWAY_ENCRYPTION_SECRET",
]) {
  text = text.replace(
    new RegExp(`^${name}=.*$`, "m"),
    `${name}=${randomBytes(32).toString("hex")}`,
  );
}
if (process.env.SOURCEWEFT_IMAGE) {
  if (!/^[a-zA-Z0-9._/:@-]+$/.test(process.env.SOURCEWEFT_IMAGE))
    throw new Error("Invalid image reference");
  text = text.replace(
    /^SOURCEWEFT_IMAGE=.*$/m,
    `SOURCEWEFT_IMAGE=${process.env.SOURCEWEFT_IMAGE}`,
  );
}
// Fail rather than overwrite an existing deployment's encryption keys or passwords.
writeFileSync(join(directory, ".env"), text, { flag: "wx", mode: 0o600 });
console.log(
  "Created .env with generated secrets. Existing configurations are never overwritten.",
);

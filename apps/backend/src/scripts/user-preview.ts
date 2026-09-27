import "dotenv/config";
import { parseArgs } from "node:util";
import { previewFeatureSchema } from "@sourceweft/contracts";
import { z } from "zod";

const usage =
  "preview:user get --user-id <id> | grant|revoke --user-id <id> --feature gmail --actor <operator> --reason <reason> [--dry-run]";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "user-id": { type: "string" },
      feature: { type: "string" },
      actor: { type: "string" },
      reason: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["get", "grant", "revoke"].includes(command ?? "") ||
    !values["user-id"]?.trim()
  ) {
    throw new Error(usage);
  }
  if (
    command === "get" &&
    (values.feature || values.actor || values.reason || values["dry-run"])
  ) {
    throw new Error("get only accepts --user-id");
  }
  const input =
    command === "get"
      ? null
      : {
          userId: values["user-id"],
          feature: previewFeatureSchema.parse(values.feature),
          actor: z.string().trim().min(1).max(200).parse(values.actor),
          reason: z.string().trim().min(1).max(1000).parse(values.reason),
          dryRun: values["dry-run"],
        };
  // Validate options before opening a pool; never output credentials or settings.
  const { previewAdminService } =
    await import("../modules/preview/admin-service");
  const { closeDatabase } = await import("@sourceweft/db");
  try {
    const result =
      command === "get"
        ? await previewAdminService.get(values["user-id"])
        : command === "grant"
          ? await previewAdminService.grant(input!)
          : await previewAdminService.revoke(input!);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Preview command failed",
  );
  process.exitCode = 1;
});

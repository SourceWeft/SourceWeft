import { UsageError } from "../errors";
import { RegistryError, type RegistryClient } from "../registry/client";
import { chooseItem } from "../ui";

export type ReferenceOptions = { skill?: string; path?: string };
export async function resolveInstallReference(
  client: RegistryClient,
  reference: string,
  options: ReferenceOptions = {},
  interactive = false,
) {
  if (!reference.includes("/")) {
    const detail = await client.getSkill(reference);
    if (
      (options.skill !== undefined && detail.skill.name !== options.skill) ||
      (options.path !== undefined && detail.source.repoSubpath !== options.path)
    )
      throw new UsageError("The selected skill does not match --skill/--path.");
    return detail;
  }
  if (!/^@?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reference))
    throw new UsageError("Use @owner/skill or owner/repo with --skill.");
  if (!reference.startsWith("@") && !options.skill)
    throw new UsageError("A repository reference requires --skill <name>.");
  const result = await client
    .resolveSkills(reference, options)
    .catch((error: unknown) => {
      if (error instanceof RegistryError && error.status === 404)
        throw new UsageError(
          "This registry does not support install references yet. Upgrade it or provide an existing skill slug.",
        );
      throw error;
    });
  if (!result.items.length)
    throw new UsageError(`No public skill matches '${reference}'.`);
  let selected = result.items[0]!;
  if (result.items.length > 1 || !result.exact) {
    const labels = result.items.map(
      (item) =>
        `${item.installRef ?? item.slug} — ${item.repoUrl ?? ""} #${item.repoSubpath ?? ""}: ${item.description}`,
    );
    if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY)
      throw new UsageError(
        `${result.items.length > 1 ? "Multiple sources match." : "This short alias is not assigned."} Use an exact reference or --path:\n${labels.join("\n")}`,
      );
    selected = result.items[await chooseItem(labels)]!;
  }
  const detail = await client.getSkill(selected.slug);
  if (
    detail.source.repoSubpath !== selected.repoSubpath ||
    detail.source.repoUrl !== selected.repoUrl
  )
    throw new UsageError(
      "The source changed during resolution. Inspect it and retry.",
    );
  return detail;
}

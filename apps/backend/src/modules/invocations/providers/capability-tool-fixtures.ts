import type { CapabilityCommandListItem } from "@sourceweft/capability-runtime";

export function capabilityCommand(
  input: Partial<CapabilityCommandListItem> & {
    readonly action: CapabilityCommandListItem["action"];
    readonly capabilityId: string;
    readonly contributionId: string;
    readonly id: string;
    readonly title: string;
  },
): CapabilityCommandListItem {
  return {
    aliases: [],
    category: null,
    displayTitle: input.title,
    order: 0,
    parentKind: null,
    parentTitle: null,
    sourcePackageName: null,
    visible: true,
    workflow: null,
    ...input,
  };
}

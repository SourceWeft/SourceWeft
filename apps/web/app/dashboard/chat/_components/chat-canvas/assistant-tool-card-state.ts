function shouldAutoOpenToolStatus(label: string) {
  return (
    label === "Running" ||
    label === "Needs approval" ||
    label === "Failed" ||
    label === "Rejected"
  );
}

export function resolveAssistantToolCardDefaultOpen(input: {
  defaultOpen?: boolean;
  hasReadFilePreview: boolean;
  statusLabel: string;
}) {
  return (
    input.defaultOpen ??
    (input.hasReadFilePreview || shouldAutoOpenToolStatus(input.statusLabel))
  );
}

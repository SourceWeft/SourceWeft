import type { FilesystemPermission } from "deepagents";
import type { AgentFilesystemMountCapability } from "@sourceweft/builtin-vfs";

export {
  buildEditFileToolDescription,
  buildFilesystemMountPrompt,
  buildFilesystemToolDescriptions,
  buildGlobToolDescription,
  buildGrepToolDescription,
  buildLsToolDescription,
  buildReadFileToolDescription,
  buildWriteFileToolDescription,
  createDefaultFilesystemMounts,
  createSandboxFilesystemMount,
  KB_READ_FILE_DEFAULT_LINE_LIMIT,
  KB_READ_FILE_MAX_LINE_LIMIT,
  KNOWLEDGE_MOUNT,
  SKILLS_MOUNT,
  WORK_MOUNT,
} from "@sourceweft/builtin-vfs";

const INTERNAL_CONTEXT_PATHS = [
  "/conversation_history",
  "/conversation_history/**",
  "/large_tool_results",
  "/large_tool_results/**",
];

function mountPaths(root: string) {
  const normalized = root === "/" ? "/" : root.replace(/\/+$/g, "");
  if (normalized === "/") {
    return ["/**"];
  }
  return [normalized, `${normalized}/**`];
}

/**
 * Converts SourceWeft's mount capabilities into Deep Agents' native,
 * first-match filesystem permissions. Deep Agents intentionally defaults
 * unmatched paths to allow, so terminal deny rules are always required. An
 * execute-capable SourceWeft CompositeBackend declares its sandbox default as
 * the `/` route, keeping every rule natively scoped; the sandbox provider's
 * path policy remains the authority for shell-visible paths used by `execute`.
 */
export function filesystemPermissionsForMounts(
  mounts: AgentFilesystemMountCapability[],
): FilesystemPermission[] {
  const permissions: FilesystemPermission[] = [
    {
      operations: ["read", "write"],
      paths: INTERNAL_CONTEXT_PATHS,
      mode: "deny",
    },
    {
      operations: ["read"],
      paths: ["/"],
      mode: "allow",
    },
  ];

  for (const mount of mounts) {
    permissions.push({
      operations: ["read"],
      paths: mountPaths(mount.root),
      mode: mount.readable ? "allow" : "deny",
    });
    permissions.push({
      operations: ["write"],
      paths: mountPaths(mount.root),
      mode: mount.writable ? "allow" : "deny",
    });
  }

  permissions.push(
    { operations: ["read"], paths: ["/**"], mode: "deny" },
    { operations: ["write"], paths: ["/**"], mode: "deny" },
  );
  return permissions;
}
export type {
  AgentFilesystemMountCapability,
  AgentFilesystemPromptOptions,
  FilesystemEvidenceRole,
} from "@sourceweft/builtin-vfs";

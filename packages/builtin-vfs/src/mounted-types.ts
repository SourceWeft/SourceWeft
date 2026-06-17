import type { BackendProtocolV2 } from "deepagents";
import type { AgentFilesystemMountCapability } from "./filesystem-capabilities";

export type MountedBackend = {
  readonly capability: AgentFilesystemMountCapability;
  readonly backend: BackendProtocolV2;
};

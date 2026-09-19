import type { ChatHubRegistration } from "./chat-hub-context";

export const HUB_PROTOCOL = 1;
export const HUB_WINDOW_PATH = "/dashboard/hub-window";
export const HUB_EVENT = "sourceweft:hub";
type DataKeys = {
  [K in keyof ChatHubRegistration]-?: ChatHubRegistration[K] extends
    ((...args: never[]) => unknown) | undefined
    ? never
    : K;
}[keyof ChatHubRegistration];
export type HubData = Pick<ChatHubRegistration, DataKeys>;
export type HubViewState = {
  tab?: string;
  artifactId?: string;
  sourceId?: string;
  workfilePath?: string;
  queries?: Record<string, string>;
  scroll?: Record<string, number>;
};
export type HubSnapshot = {
  protocolVersion: number;
  sessionId: string;
  accountId: string;
  targetWorkspaceId?: string | null;
  contextKey: string;
  revision: number;
  title: string;
  phase: "active" | "transition" | "away";
  data: HubData;
  view?: HubViewState;
};
export type HubAction =
  | { type: "work-folder"; folderId: string }
  | { type: "choose-work-folder" }
  | { type: "sources"; ids: string[] }
  | { type: "auto-sources"; ids: string[] }
  | { type: "skills"; ids: string[] }
  | { type: "mcp"; installIds: string[]; toolIds: string[] }
  | { type: "sources-loaded"; sources: ChatHubRegistration["initialSources"] }
  | {
      type: "connectors";
      connectors: import("@sourceweft/sdk").SourceConnector[];
    }
  | { type: "refresh-skills" }
  | { type: "locate"; messageId: string }
  | { type: "return" };
export type HubCommand = {
  id: string;
  sessionId: string;
  contextKey: string;
  revision: number;
  action: HubAction;
};
export type HubMessage =
  | {
      kind: "local-file-request";
      request: import("../../../../lib/hub-file-relay").HubFileRequest;
    }
  | {
      kind: "local-file-result";
      result: import("../../../../lib/hub-file-relay").HubFileResult;
    }
  | { kind: "barrier"; id: string }
  | { kind: "barrier-result"; id: string; pending: boolean }
  | { kind: "ready"; accountId: string; protocolVersion: number }
  | { kind: "snapshot"; snapshot: HubSnapshot }
  | { kind: "applied"; sessionId: string; contextKey: string; revision: number }
  | { kind: "command"; command: HubCommand }
  | { kind: "result"; id: string; error?: string }
  | { kind: "dock"; sessionId: string; contextKey: string; view?: HubViewState }
  | { kind: "dock-applied"; sessionId: string; error?: string }
  | { kind: "view"; sessionId: string; contextKey: string; view: HubViewState }
  | { kind: "closed"; reason: string }
  | { kind: "destroyed" | "disconnected" | "close-requested" };

export function serializableHubData(
  registration: ChatHubRegistration,
): HubData {
  const data = Object.fromEntries(
    Object.entries(registration).filter(
      ([, value]) => typeof value !== "function",
    ),
  ) as HubData;
  // Artifact detail can contain file bodies; only its identifier belongs in view state.
  return { ...data, previewArtifact: null };
}

export function hubContextKey(
  accountId: string,
  workspaceId: string | null,
  id: string,
) {
  return JSON.stringify([accountId, workspaceId, id]);
}

export function validateHubCommand(
  command: HubCommand,
  snapshot: HubSnapshot,
): string | null {
  if (
    !command ||
    typeof command.id !== "string" ||
    !command.action ||
    typeof command.action !== "object"
  )
    return "Invalid Hub command.";
  if (
    command.sessionId !== snapshot.sessionId ||
    command.contextKey !== snapshot.contextKey
  )
    return "The conversation changed. Please try again in the current Hub.";
  if (
    command.revision !== snapshot.revision &&
    ![
      "sources-loaded",
      "connectors",
      "refresh-skills",
      "auto-sources",
      "return",
    ].includes(command.action.type)
  )
    return "Hub state changed. Review the current selection and try again.";
  if (snapshot.phase !== "active" && command.action.type !== "return")
    return "Return to the conversation before changing Hub selections.";
  const ids = (value: unknown) =>
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every((id) => typeof id === "string" && id.length <= 500);
  switch (command.action.type) {
    case "work-folder":
    case "choose-work-folder":
      if (
        snapshot.data.mode !== "new" ||
        snapshot.data.draftWorkContext?.disabled ||
        snapshot.data.draftWorkContext?.target?.kind !== "local"
      )
        return "The working directory can only be changed before starting a local conversation.";
      return command.action.type === "choose-work-folder" ||
        (typeof command.action.folderId === "string" &&
          command.action.folderId.length <= 500)
        ? null
        : "Invalid folder selection.";
    case "auto-sources":
    case "sources":
    case "skills":
      return ids(command.action.ids) ? null : "Invalid selection.";
    case "mcp":
      return ids(command.action.installIds) && ids(command.action.toolIds)
        ? null
        : "Invalid MCP selection.";
    case "connectors":
      return Array.isArray(command.action.connectors)
        ? null
        : "Invalid connectors.";
    case "sources-loaded":
      return Array.isArray(command.action.sources) ? null : "Invalid sources.";
    case "locate":
      return typeof command.action.messageId === "string"
        ? null
        : "Invalid message.";
    case "refresh-skills":
    case "return":
      return null;
    default:
      return "Unsupported Hub action.";
  }
}

export class HubViewCache {
  private values = new Map<string, HubViewState>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: HubViewState) {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > 50)
      this.values.delete(this.values.keys().next().value!);
  }
  clear() {
    this.values.clear();
  }
}

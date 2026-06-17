"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ListCapabilityCatalogResponse,
  McpToolSelection,
  SourceConnector,
} from "@sourceweft/sdk";
import type {
  ChatSkillItem,
  ChatToolName,
  CitationRecord,
} from "./chat-canvas";
import type { ArtifactListItem, ThreadCitationRecord } from "./sources-hub";
import type { SourceItem } from "./source-types";

export type ChatHubMode = "new" | "thread";

export type ChatHubRegistration = {
  mode: ChatHubMode;
  workspaceId: string | null;
  workspaceName: string | null;
  threadId: string | null;
  activeCitationIndex: number | null;
  activeCitationMessageId: string | null;
  displayedCitations: CitationRecord[];
  threadCitations: ThreadCitationRecord[];
  artifactsRefreshKey: number;
  workfilesRefreshKey: number;
  initialSources: SourceItem[];
  initialSourcesLoaded: boolean;
  activeSourceIds: string[];
  activeSkillIds: string[];
  activeMcpInstallIds: string[];
  activeMcpToolIds: string[];
  availableSkills: ChatSkillItem[];
  hubSkills: ChatSkillItem[];
  capabilityCatalog: ListCapabilityCatalogResponse | null;
  disabledToolNames: ChatToolName[];
  onSelectionChange: (sourceIds: string[]) => void;
  onSkillSelectionChange: (skillIds: string[]) => void;
  onMcpSelectionChange: (selection: McpToolSelection) => void;
  onConnectorsChange?: (connectors: SourceConnector[]) => void;
  onSkillsCatalogChange: () => Promise<void>;
  onCitationOpen?: (
    citation: CitationRecord,
    context?: { messageId?: string },
  ) => void;
  onCitationLocate?: (messageId: string) => void;
  onArtifactOpen: (artifact: ArtifactListItem) => void;
  previewArtifact: ArtifactListItem | null;
  onArtifactPreviewClose: () => void;
  onSourceLoad: (sources: SourceItem[]) => void;
  onSourceMerge: (sources: SourceItem[]) => void;
};

type ChatHubContextValue = {
  registration: ChatHubRegistration;
  mobileHubOpen: boolean;
  setMobileHubOpen: (open: boolean) => void;
  setRegistration: (partial: Partial<ChatHubRegistration>) => void;
};

const NOOP_ON_SELECTION_CHANGE: ChatHubRegistration["onSelectionChange"] =
  () => {};
const NOOP_ON_SKILL_SELECTION_CHANGE: ChatHubRegistration["onSkillSelectionChange"] =
  () => {};
const NOOP_ON_MCP_SELECTION_CHANGE: ChatHubRegistration["onMcpSelectionChange"] =
  () => {};
const NOOP_ON_SKILLS_CATALOG_CHANGE: ChatHubRegistration["onSkillsCatalogChange"] =
  async () => {};
const NOOP_ON_ARTIFACT_OPEN: ChatHubRegistration["onArtifactOpen"] = () => {};
const NOOP_ON_ARTIFACT_PREVIEW_CLOSE: ChatHubRegistration["onArtifactPreviewClose"] =
  () => {};
const NOOP_ON_SOURCE_LOAD: ChatHubRegistration["onSourceLoad"] = () => {};
const NOOP_ON_SOURCE_MERGE: ChatHubRegistration["onSourceMerge"] = () => {};
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function buildDefaultRegistration(): ChatHubRegistration {
  return {
    mode: "new",
    workspaceId: null,
    workspaceName: null,
    threadId: null,
    activeCitationIndex: null,
    activeCitationMessageId: null,
    displayedCitations: [],
    threadCitations: [],
    artifactsRefreshKey: 0,
    workfilesRefreshKey: 0,
    initialSources: [],
    initialSourcesLoaded: false,
    activeSourceIds: [],
    activeSkillIds: [],
    activeMcpInstallIds: [],
    activeMcpToolIds: [],
    availableSkills: [],
    hubSkills: [],
    capabilityCatalog: null,
    disabledToolNames: [],
    onSelectionChange: NOOP_ON_SELECTION_CHANGE,
    onSkillSelectionChange: NOOP_ON_SKILL_SELECTION_CHANGE,
    onMcpSelectionChange: NOOP_ON_MCP_SELECTION_CHANGE,
    onSkillsCatalogChange: NOOP_ON_SKILLS_CATALOG_CHANGE,
    onArtifactOpen: NOOP_ON_ARTIFACT_OPEN,
    previewArtifact: null,
    onArtifactPreviewClose: NOOP_ON_ARTIFACT_PREVIEW_CLOSE,
    onSourceLoad: NOOP_ON_SOURCE_LOAD,
    onSourceMerge: NOOP_ON_SOURCE_MERGE,
  };
}

const ChatHubContext = createContext<ChatHubContextValue | null>(null);

export function ChatHubProvider({
  initialValue,
  children,
}: {
  initialValue?: Partial<ChatHubRegistration>;
  children: ReactNode;
}) {
  const [registration, setRegistrationState] = useState<ChatHubRegistration>(
    () => ({
      ...buildDefaultRegistration(),
      ...initialValue,
    }),
  );
  const [mobileHubOpen, setMobileHubOpen] = useState(false);

  const setRegistration = useCallback(
    (partial: Partial<ChatHubRegistration>) => {
      setRegistrationState((prev) => ({ ...prev, ...partial }));
    },
    [],
  );

  const value = useMemo(
    () => ({ mobileHubOpen, registration, setMobileHubOpen, setRegistration }),
    [mobileHubOpen, registration, setRegistration],
  );

  return (
    <ChatHubContext.Provider value={value}>{children}</ChatHubContext.Provider>
  );
}

export function useChatHubContext() {
  return useContext(ChatHubContext);
}

export function useRegisterChatHub(
  registration: ChatHubRegistration,
  enabled = true,
) {
  const context = useChatHubContext();
  const setRegistration = context?.setRegistration;

  useBrowserLayoutEffect(() => {
    if (!enabled || !setRegistration) return;
    setRegistration(registration);
  }, [enabled, registration, setRegistration]);
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatSkillItem,
  ChatToolName,
  PromptInputMentionSourceLoader,
} from "../../_components/chat-canvas";
import {
  getCachedWorkspaceSources,
  hasCachedWorkspaceSources,
  setCachedWorkspaceSources,
} from "../../_components/source-library-cache";
import {
  getSourceSelectionStorageKey,
  readStoredSourceSelection,
  writeStoredSourceSelection,
} from "../../_components/source-selection-storage";
import {
  readStoredMcpSelection,
  writeStoredMcpSelection,
} from "../../_components/mcp-selection-storage";
import {
  expandSelectedSources,
  type SourceItem,
} from "../../_components/source-types";
import { contentClient } from "../../../../../lib/sdk";
import type { ListCapabilityCatalogResponse } from "@sourceweft/sdk";
import type {
  ListSkillsCatalogResponse,
  ListWorkspaceSkillsResponse,
} from "@sourceweft/contracts";
import { removeDisabledToolSkills } from "./thread-utils";
import {
  coerceSkillIdsSelection,
  normalizeSkillIdsForRequest,
  resolveDefaultActiveSkillIds,
  SKILL_SELECTION_LIMIT_MESSAGE,
} from "../../_components/chat-canvas/tool-selection";
import { toast } from "sonner";

type UseThreadSourcesInput = {
  threadId: string;
  workspaceId: string | null;
};

function catalogBuiltinSkillToChatSkill(
  skill: ListSkillsCatalogResponse["items"][number],
): ChatSkillItem | null {
  if (
    skill.sourceType !== "builtin" ||
    skill.installable ||
    !skill.selectionId
  ) {
    return null;
  }
  return {
    id: skill.selectionId,
    catalogId: skill.catalogId,
    slug: skill.slug,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    sourceType: skill.sourceType,
    version: skill.version,
    hasReadme: skill.hasReadme,
    capabilities: skill.capabilities,
    models: skill.models,
    tools: skill.tools,
    slash: skill.slash,
    slashConfig: skill.slashConfig,
    commands: skill.commands,
    defaultConfig: skill.defaultConfig,
    defaultEnabled: skill.defaultEnabled,
    options: skill.options,
  };
}

function workspaceInstalledSkillToChatSkill(
  skill: ListWorkspaceSkillsResponse["items"][number],
): ChatSkillItem | null {
  return {
    id: skill.selectionId,
    workspaceSkillId: skill.workspaceSkillId,
    catalogId: skill.catalogId,
    slug: skill.slug,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    sourceType: skill.sourceType,
    version: skill.version,
    enabled: skill.enabled,
    hasReadme: false,
    capabilities: skill.capabilities,
    models: skill.models,
    tools: skill.tools,
    slash: skill.slash,
    slashConfig: skill.slashConfig,
    commands: skill.commands,
    defaultConfig: skill.defaultConfig,
    options: skill.options,
  };
}

export function useThreadSources({
  threadId,
  workspaceId,
}: UseThreadSourcesInput) {
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [hubSkills, setHubSkills] = useState<ChatSkillItem[]>([]);
  const [capabilityCatalog, setCapabilityCatalog] =
    useState<ListCapabilityCatalogResponse | null>(null);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const handleSkillSelectionChange = useCallback((skillIds: string[]) => {
    const { skillIds: nextSkillIds, wasLimited } =
      coerceSkillIdsSelection(skillIds);
    if (wasLimited) {
      toast.info(SKILL_SELECTION_LIMIT_MESSAGE);
    }
    setActiveSkillIds(nextSkillIds);
  }, []);
  const [activeMcpInstallIds, setActiveMcpInstallIds] = useState<string[]>([]);
  const [activeMcpToolIds, setActiveMcpToolIds] = useState<string[]>([]);
  const [disabledToolNames, setDisabledToolNames] = useState<ChatToolName[]>(
    [],
  );
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const skillsLoadGenerationRef = useRef(0);
  const capabilityCatalogLoadGenerationRef = useRef(0);

  const initialSourcesForWorkspace = useMemo(
    () => getCachedWorkspaceSources(workspaceId) ?? librarySources,
    [librarySources, workspaceId],
  );

  const selectionStorageKey = useMemo(
    () =>
      workspaceId ? getSourceSelectionStorageKey(workspaceId, threadId) : null,
    [workspaceId, threadId],
  );

  useEffect(() => {
    setLibrarySources(getCachedWorkspaceSources(workspaceId) ?? []);
  }, [workspaceId]);

  useEffect(() => {
    setSelectionLoaded(false);
    if (!workspaceId) {
      setActiveSourceIds([]);
      setActiveMcpInstallIds([]);
      setActiveMcpToolIds([]);
      setSelectionLoaded(true);
      return;
    }
    setActiveSourceIds(readStoredSourceSelection(workspaceId, threadId));
    // MCP selection is per-thread too: restore THIS thread's selection (empty
    // for a thread never configured), so switching threads never leaks one
    // thread's MCP servers onto another's messages.
    const storedMcp = readStoredMcpSelection(workspaceId, threadId);
    setActiveMcpInstallIds(storedMcp.installIds);
    setActiveMcpToolIds(storedMcp.toolIds);
    setSelectionLoaded(true);
  }, [selectionStorageKey, threadId, workspaceId]);

  useEffect(() => {
    if (!selectionLoaded || !workspaceId) return;
    writeStoredSourceSelection(workspaceId, threadId, activeSourceIds);
    writeStoredSourceSelection(workspaceId, "current", activeSourceIds);
  }, [
    activeSourceIds,
    selectionLoaded,
    selectionStorageKey,
    threadId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!selectionLoaded || !workspaceId) return;
    writeStoredMcpSelection(workspaceId, threadId, {
      installIds: activeMcpInstallIds,
      toolIds: activeMcpToolIds,
    });
  }, [
    activeMcpInstallIds,
    activeMcpToolIds,
    selectionLoaded,
    selectionStorageKey,
    threadId,
    workspaceId,
  ]);

  const persistActiveSourceIds = useCallback(
    (sourceIds: string[]) => {
      setActiveSourceIds(sourceIds);
      if (workspaceId) {
        writeStoredSourceSelection(workspaceId, threadId, sourceIds);
        writeStoredSourceSelection(workspaceId, "current", sourceIds);
      }
    },
    [threadId, workspaceId],
  );

  const loadSourceMentions = useCallback<PromptInputMentionSourceLoader>(
    async ({ cursor, limit, query }) => {
      if (!workspaceId) {
        return { items: [], nextCursor: null };
      }

      const result = await contentClient.listSourceMentions(workspaceId, {
        cursor: cursor ?? undefined,
        limit,
        query: query || undefined,
      });
      return {
        items: result.items.map((source) => ({
          id: source.id,
          meta:
            source.status === "failed"
              ? "Processing failed"
              : source.status === "queued" || source.status === "processing"
                ? "Sync in progress"
                : new Date(source.updatedAt).toLocaleString(),
          title: source.title || "Untitled",
          type: source.mimeType ?? source.sourceType,
        })),
        nextCursor: result.nextCursor,
      };
    },
    [workspaceId],
  );

  const handleLibrarySourcesLoad = useCallback(
    (sources: SourceItem[]) => {
      setCachedWorkspaceSources(workspaceId, sources);
      setLibrarySources(sources);
    },
    [workspaceId],
  );

  const handleLibrarySourcesMerge = useCallback((sources: SourceItem[]) => {
    setLibrarySources((current) => {
      const mergedById = new Map(current.map((source) => [source.id, source]));
      for (const source of sources) {
        mergedById.set(source.id, source);
      }
      return Array.from(mergedById.values());
    });
  }, []);

  const loadAvailableSkills = useCallback(async () => {
    const loadGeneration = ++skillsLoadGenerationRef.current;
    if (!workspaceId) {
      setAvailableSkills([]);
      setHubSkills([]);
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const [installedResult, catalogResult] = await Promise.all([
        contentClient.listWorkspaceSkills(activeWorkspaceId),
        contentClient.listSkillsCatalog(activeWorkspaceId),
      ]);
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        activeWorkspaceId !== workspaceId
      ) {
        return;
      }
      const builtinOptionSkills = catalogResult.items
        .map(catalogBuiltinSkillToChatSkill)
        .filter((skill): skill is ChatSkillItem => Boolean(skill));
      const workspaceInstalledSkills = installedResult.items
        .map(workspaceInstalledSkillToChatSkill)
        .filter((skill): skill is ChatSkillItem => Boolean(skill));
      const enabledWorkspaceSkills = workspaceInstalledSkills.filter(
        (skill) => skill.enabled,
      );
      const enabledSkills = [...builtinOptionSkills, ...enabledWorkspaceSkills];
      setAvailableSkills(enabledSkills);
      setHubSkills([...builtinOptionSkills, ...workspaceInstalledSkills]);

      const optionControlledIds = new Set(
        builtinOptionSkills.map((skill) => skill.id),
      );
      setActiveSkillIds((current) =>
        resolveDefaultActiveSkillIds({
          availableSkills: builtinOptionSkills,
          currentSkillIds: current.filter((id) => optionControlledIds.has(id)),
        }),
      );
    } catch {
      if (skillsLoadGenerationRef.current !== loadGeneration) {
        return;
      }
      setAvailableSkills([]);
      setHubSkills([]);
      setActiveSkillIds([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAvailableSkills();
  }, [loadAvailableSkills]);

  useEffect(() => {
    const loadGeneration = ++capabilityCatalogLoadGenerationRef.current;
    if (!workspaceId) {
      setCapabilityCatalog(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    void contentClient
      .listCapabilityCatalog(activeWorkspaceId)
      .then((result) => {
        if (
          capabilityCatalogLoadGenerationRef.current !== loadGeneration ||
          activeWorkspaceId !== workspaceId
        ) {
          return;
        }
        setCapabilityCatalog(result);
      })
      .catch(() => {
        if (capabilityCatalogLoadGenerationRef.current !== loadGeneration) {
          return;
        }
        setCapabilityCatalog({ commands: [], tools: [] });
      });
  }, [workspaceId]);

  const effectiveActiveSkillIds = useMemo(
    () =>
      removeDisabledToolSkills({
        skillIds: activeSkillIds,
        availableSkills,
        disabledToolNames,
      }),
    [activeSkillIds, availableSkills, disabledToolNames],
  );

  const selectedSources = useMemo(
    () => expandSelectedSources(librarySources, activeSourceIds),
    [activeSourceIds, librarySources],
  );

  return {
    activeMcpInstallIds,
    activeMcpToolIds,
    activeSkillIds,
    activeSourceIds,
    availableSkills,
    hubSkills,
    capabilityCatalog,
    disabledToolNames,
    effectiveActiveSkillIds,
    handleLibrarySourcesLoad,
    handleLibrarySourcesMerge,
    hasCachedWorkspaceSources,
    initialSourcesForWorkspace,
    librarySources,
    loadAvailableSkills,
    loadSourceMentions,
    persistActiveSourceIds,
    selectedSources,
    setActiveMcpInstallIds,
    setActiveMcpToolIds,
    setActiveSkillIds,
    handleSkillSelectionChange,
    setDisabledToolNames,
  };
}

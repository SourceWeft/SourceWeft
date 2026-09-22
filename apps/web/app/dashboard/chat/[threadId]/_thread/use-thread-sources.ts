"use client";

import { formatDisplayDate } from "@/lib/i18n/format";
import { useLocale as useDisplayLocale } from "next-intl";
import { useSourceSelection } from "./use-source-selection";

import { authClient } from "../../../../../lib/auth-client";
import { hubSkillMemory } from "../../../../../lib/hub-skill-memory";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  ChatSkillItem,
  ChatToolName,
  PromptInputMentionSourceLoader,
} from "../../_components/chat-canvas";
import {
  getCachedWorkspaceHubValue,
  hasCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../../_components/sources-hub/workspace-hub-cache";
import {
  readStoredMcpSelection,
  writeStoredMcpSelection,
} from "../../_components/mcp-selection-storage";
import {
  expandSelectedSources,
  WORKSPACE_SOURCES_CACHE_BUCKET,
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
  resolveDefaultActiveSkillIds,
  MAX_SELECTED_SKILL_IDS_PER_TURN,
} from "../../_components/chat-canvas/tool-selection";
import { toast } from "sonner";

type UseThreadSourcesInput = {
  threadId: string;
  workspaceId: string | null;
};

function getCachedWorkspaceSources(workspaceId: string | null | undefined) {
  return getCachedWorkspaceHubValue<SourceItem[]>(
    WORKSPACE_SOURCES_CACHE_BUCKET,
    workspaceId,
  );
}

function hasCachedWorkspaceSources(workspaceId: string | null | undefined) {
  return hasCachedWorkspaceHubValue(
    WORKSPACE_SOURCES_CACHE_BUCKET,
    workspaceId,
  );
}

function setCachedWorkspaceSources(
  workspaceId: string | null | undefined,
  sources: SourceItem[],
) {
  setCachedWorkspaceHubValue<SourceItem[]>(
    WORKSPACE_SOURCES_CACHE_BUCKET,
    workspaceId,
    sources,
  );
}

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
    logo: skill.logo,
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
    logo: skill.logo,
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
    ...(skill.registryCapability
      ? { registryCapability: skill.registryCapability }
      : {}),
    ...(skill.installedVia === "agent" ? { installedVia: "agent" } : {}),
    ...(skill.updateAvailable === true ? { updateAvailable: true } : {}),
  };
}

export function useThreadSources({
  threadId,
  workspaceId,
}: UseThreadSourcesInput) {
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardChat");
  const tCanvas = useTranslations("dashboardChatCanvas");
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const {
    activeSourceIds,
    persistActiveSourceIds,
    sourceSelectionReady,
    sourceSelectionRevision,
  } = useSourceSelection(workspaceId, threadId);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [hubSkills, setHubSkills] = useState<ChatSkillItem[]>([]);
  const [capabilityCatalog, setCapabilityCatalog] =
    useState<ListCapabilityCatalogResponse | null>(null);
  const { data: hubSession } = authClient.useSession();
  const accountId = hubSession?.user.id;
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const skillScope = useRef("");
  const preserveSkillChoice = useRef(false);
  const skillChoiceReady = useRef(false);
  useEffect(() => {
    if (!accountId || !workspaceId) return;
    skillScope.current = "";
    preserveSkillChoice.current = hubSkillMemory.has(
      accountId,
      workspaceId,
      threadId,
    );
    skillChoiceReady.current = preserveSkillChoice.current;
    setActiveSkillIds(hubSkillMemory.read(accountId, workspaceId, threadId));
  }, [accountId, workspaceId, threadId]);
  useEffect(() => {
    if (
      accountId &&
      workspaceId &&
      skillChoiceReady.current &&
      skillScope.current === JSON.stringify([accountId, workspaceId, threadId])
    ) {
      hubSkillMemory.write(accountId, workspaceId, threadId, activeSkillIds);
    }
    skillScope.current = JSON.stringify([accountId, workspaceId, threadId]);
  }, [accountId, workspaceId, threadId, activeSkillIds]);
  // The checked skills are saved on the thread, so they survive a reload and
  // follow the conversation to another device. Only an explicit choice is
  // saved: a thread nobody has chosen for keeps following the defaults.
  const saveSkillSelection = useCallback(
    (skillIds: string[]) => {
      // "current" is the new-chat draft: its choice travels into the thread
      // it creates and is saved there.
      if (!workspaceId || threadId === "current") return;
      void contentClient
        .updateThreadChatPreferences(workspaceId, threadId, { skillIds })
        .catch(() => {
          toast.error(tCanvas("composer.skillSelectionSaveFailed"));
        });
    },
    [tCanvas, threadId, workspaceId],
  );
  const handleSkillSelectionChange = useCallback(
    (skillIds: string[]) => {
      preserveSkillChoice.current = true;
      skillChoiceReady.current = true;
      const { skillIds: nextSkillIds, wasLimited } =
        coerceSkillIdsSelection(skillIds);
      if (wasLimited) {
        toast.info(
          tCanvas("composer.skillLimit", {
            max: MAX_SELECTED_SKILL_IDS_PER_TURN,
          }),
        );
      }
      setActiveSkillIds(nextSkillIds);
      saveSkillSelection(nextSkillIds);
    },
    [saveSkillSelection, tCanvas],
  );
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
    () => (workspaceId ? `${workspaceId}:${threadId}` : null),
    [workspaceId, threadId],
  );

  useEffect(() => {
    setLibrarySources(getCachedWorkspaceSources(workspaceId) ?? []);
  }, [workspaceId]);

  useEffect(() => {
    setSelectionLoaded(false);
    if (!workspaceId) {
      setActiveMcpInstallIds([]);
      setActiveMcpToolIds([]);
      setSelectionLoaded(true);
      return;
    }
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
              ? t("sourceMeta.processingFailed")
              : source.status === "queued" || source.status === "processing"
                ? t("sourceMeta.syncInProgress")
                : formatDisplayDate(new Date(source.updatedAt), displayLocale),
          title: source.title || t("sourceMeta.untitled"),
          type: source.mimeType ?? source.sourceType,
        })),
        nextCursor: result.nextCursor,
      };
    },
    [workspaceId, t, displayLocale],
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
    const expectedSkillScope = JSON.stringify([
      accountId,
      workspaceId,
      threadId,
    ]);
    if (!workspaceId) {
      setAvailableSkills([]);
      setHubSkills([]);
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const [installedResult, catalogResult, savedSkillIds] = await Promise.all(
        [
          contentClient.listWorkspaceSkills(activeWorkspaceId),
          contentClient.listSkillsCatalog(activeWorkspaceId),
          // A failed read only loses the saved choice; the defaults still load.
          threadId === "current"
            ? null
            : contentClient
                .getThread(activeWorkspaceId, threadId)
                .then(
                  (result) => result.thread.chatPreferences.skillIds ?? null,
                )
                .catch(() => null),
        ],
      );
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        skillScope.current !== expectedSkillScope ||
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

      const availableIds = new Set(enabledSkills.map((skill) => skill.id));
      skillChoiceReady.current = true;
      // A choice made in this session wins, then the one saved on the
      // thread, then the defaults.
      if (!preserveSkillChoice.current && savedSkillIds) {
        preserveSkillChoice.current = true;
        setActiveSkillIds(
          coerceSkillIdsSelection(
            savedSkillIds.filter((id) => availableIds.has(id)),
          ).skillIds,
        );
        return;
      }
      setActiveSkillIds((current) =>
        preserveSkillChoice.current
          ? coerceSkillIdsSelection(
              current.filter((id) => availableIds.has(id)),
            ).skillIds
          : resolveDefaultActiveSkillIds({
              availableSkills: builtinOptionSkills,
              currentSkillIds: current.filter((id) => availableIds.has(id)),
            }),
      );
    } catch {
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        skillScope.current !== expectedSkillScope
      ) {
        return;
      }
      setAvailableSkills([]);
      setHubSkills([]);
      skillChoiceReady.current = false;
      setActiveSkillIds([]);
    }
  }, [workspaceId, threadId, accountId]);

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
    sourceSelectionReady,
    sourceSelectionRevision,
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

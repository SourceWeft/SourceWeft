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
  expandSelectedSources,
  type SourceItem,
} from "../../_components/source-types";
import { contentClient } from "../../../../../lib/sdk";
import { removeDisabledToolSkills } from "./thread-utils";

type UseThreadSourcesInput = {
  threadId: string;
  workspaceId: string | null;
};

export function useThreadSources({
  threadId,
  workspaceId,
}: UseThreadSourcesInput) {
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [disabledToolNames, setDisabledToolNames] = useState<ChatToolName[]>([]);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const skillsLoadGenerationRef = useRef(0);

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
      setSelectionLoaded(true);
      return;
    }
    setActiveSourceIds(readStoredSourceSelection(workspaceId, threadId));
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
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const result = await contentClient.listSkillsCatalog(activeWorkspaceId);
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        activeWorkspaceId !== workspaceId
      ) {
        return;
      }
      const enabledSkills = result.items
        .filter((skill) => skill.enabled && skill.enabledWorkspaceSkillId)
        .map((skill) => ({
          id: skill.enabledWorkspaceSkillId as string,
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
        }));
      setAvailableSkills(enabledSkills);

      const enabledIds = new Set(enabledSkills.map((skill) => skill.id));
      setActiveSkillIds((current) =>
        current.filter((id) => enabledIds.has(id)).slice(0, 5),
      );
    } catch {
      if (skillsLoadGenerationRef.current !== loadGeneration) {
        return;
      }
      setAvailableSkills([]);
      setActiveSkillIds([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAvailableSkills();
  }, [loadAvailableSkills]);

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
    activeSkillIds,
    activeSourceIds,
    availableSkills,
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
    setActiveSkillIds,
    setDisabledToolNames,
  };
}

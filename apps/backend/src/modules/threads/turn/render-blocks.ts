import type { MessageRenderBlock } from "./types";

function cloneBlocks(blocks: MessageRenderBlock[]) {
  return blocks.map((block) => ({ ...block })) as MessageRenderBlock[];
}

function trimOuterTextBlocks(blocks: MessageRenderBlock[]) {
  const next = cloneBlocks(blocks);
  const firstTextIndex = next.findIndex((block) => block.type === "text");
  const lastTextIndex = [...next]
    .reverse()
    .findIndex((block) => block.type === "text");

  if (firstTextIndex >= 0) {
    const block = next[firstTextIndex];
    if (block?.type === "text") {
      block.text = block.text.trimStart();
    }
  }

  if (lastTextIndex >= 0) {
    const index = next.length - 1 - lastTextIndex;
    const block = next[index];
    if (block?.type === "text") {
      block.text = block.text.trimEnd();
    }
  }

  return next.filter((block) => block.type !== "text" || block.text.length > 0);
}

export function finalizeMessageRenderBlocks(input: {
  blocks: MessageRenderBlock[];
  finalText: string;
}) {
  if (input.blocks.length === 0) {
    return [] as MessageRenderBlock[];
  }
  return trimOuterTextBlocks(input.blocks);
}

/**
 * The text, reasoning and tool blocks a continued message already shows, read
 * from its stored metadata. Committed artifact outputs are left out: the
 * continuation merge keeps those on its own.
 */
export function readContinuationRenderBlocks(
  value: unknown,
): MessageRenderBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): MessageRenderBlock[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const block = entry as Record<string, unknown>;
    if (typeof block.id !== "string" || !block.id) {
      return [];
    }
    if (
      (block.type === "text" || block.type === "reasoning") &&
      typeof block.text === "string"
    ) {
      return [
        {
          id: block.id,
          type: block.type,
          text: block.text,
          ...(block.type === "reasoning" && typeof block.durationMs === "number"
            ? { durationMs: block.durationMs }
            : {}),
        } as MessageRenderBlock,
      ];
    }
    if (block.type === "tool" && typeof block.toolCallId === "string") {
      return [{ id: block.id, type: "tool", toolCallId: block.toolCallId }];
    }
    return [];
  });
}

/**
 * Builds a turn's render blocks. `initialBlocks` are the blocks a continued
 * message already shows (a turn resumed after an approval or a question): they
 * stay as they are, ahead of what this run adds — new text never merges into
 * them and a text replace only rewrites text this run wrote — and new text ids
 * continue after theirs.
 */
export function createMessageRenderBlockBuilder(
  initialBlocks: readonly MessageRenderBlock[] = [],
) {
  const blocks: MessageRenderBlock[] = cloneBlocks([...initialBlocks]);
  const seededCount = blocks.length;
  let nextTextId =
    Math.max(
      0,
      ...blocks.flatMap((block) => {
        const match =
          block.type === "text" ? /^text-(\d+)$/.exec(block.id) : null;
        return match ? [Number(match[1])] : [];
      }),
    ) + 1;

  return {
    appendArtifactOutput(input: {
      artifactId: string;
      artifactVersionId: string;
      producer: {
        kind: "main" | "subagent";
        subagentType?: string;
      };
      sourceToolCallId: string;
      threadRunId: string;
    }) {
      const id = `artifact-output:${input.threadRunId}:${input.artifactId}:${input.artifactVersionId}`;
      if (
        blocks.some((block) => block.type === "artifact_output" && block.id === id)
      ) {
        return;
      }

      blocks.push({
        artifactId: input.artifactId,
        artifactVersionId: input.artifactVersionId,
        id,
        placement: "terminal",
        producer: input.producer,
        sequence: blocks.filter((block) => block.type === "artifact_output").length + 1,
        sourceToolCallId: input.sourceToolCallId,
        threadRunId: input.threadRunId,
        type: "artifact_output",
      });
    },
    appendTool(toolCallId: string) {
      if (
        blocks.some(
          (block) => block.type === "tool" && block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      blocks.push({
        id: `tool-${toolCallId}`,
        type: "tool",
        toolCallId,
      });
    },
    appendReasoning(input: {
      durationMs?: number;
      id: string;
      text: string;
    }) {
      if (!input.text) {
        return;
      }

      const existing = blocks.find(
        (block) => block.type === "reasoning" && block.id === input.id,
      );
      if (existing?.type === "reasoning") {
        existing.text += input.text;
        if (typeof input.durationMs === "number") {
          existing.durationMs = input.durationMs;
        }
        return;
      }

      blocks.push({
        id: input.id,
        type: "reasoning",
        text: input.text,
        ...(typeof input.durationMs === "number"
          ? { durationMs: input.durationMs }
          : {}),
      });
    },
    appendText(text: string) {
      if (!text) {
        return;
      }

      const last = blocks[blocks.length - 1];
      if (last?.type === "text" && blocks.length > seededCount) {
        last.text += text;
        return;
      }

      blocks.push({
        id: `text-${nextTextId}`,
        type: "text",
        text,
      });
      nextTextId += 1;
    },
    replaceText(text: string) {
      if (!text) {
        for (let index = blocks.length - 1; index >= seededCount; index -= 1) {
          if (blocks[index]?.type === "text") {
            blocks.splice(index, 1);
          }
        }
        return;
      }

      let lastTextIndex = -1;
      for (let index = blocks.length - 1; index >= seededCount; index -= 1) {
        if (blocks[index]?.type === "text") {
          lastTextIndex = index;
          break;
        }
      }
      if (lastTextIndex >= 0) {
        const prefix = blocks
          .slice(seededCount, lastTextIndex)
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const lastText = blocks[lastTextIndex];
        if (lastText?.type === "text" && text.startsWith(prefix)) {
          lastText.text = text.slice(prefix.length);
          return;
        }
      }

      for (let index = blocks.length - 1; index >= seededCount; index -= 1) {
        if (blocks[index]?.type === "text") {
          blocks.splice(index, 1);
        }
      }

      blocks.push({
        id: `text-${nextTextId}`,
        type: "text",
        text,
      });
      nextTextId += 1;
    },
    list() {
      return cloneBlocks(blocks);
    },
  };
}

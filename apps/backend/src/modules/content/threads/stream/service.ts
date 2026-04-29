import { invokeDeepAgentTurn, type DeepAgentTurnOutcome } from "../../agent/turn/runner";
import { ContentError } from "../../errors";
import { toContentServiceError } from "../../model-gateway-error";
import { logger } from "../../../../shared/logger";
import {
  type ContentThreadTurnService,
  type StreamThreadEventInput,
} from "../turn/service";
import { mapDeepAgentEventToSse } from "./event-mapper";
import {
  createErrorAssistantMessage,
  recordThreadStreamFailure,
} from "./error";
import { toSseData, withTimeout } from "./helpers";
import {
  resolveEditThreadStreamInput,
  resolveRefreshThreadStreamInput,
} from "./input";
import type { EditThreadInput, RefreshThreadInput } from "./types";

const CHAT_TITLE_WAIT_MS = 5000;

function shouldGenerateAutomaticThreadTitle(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return prepared.isFirstAssistantResponse && !prepared.assistantMessageParentId;
}

async function generateAndApplyGeneratedThreadTitle(input: {
  turnService: ContentThreadTurnService;
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  llm: StreamThreadEventInput["llm"];
  titleTask?: Promise<string | null>;
  yieldTitleUpdate?: (thread: { id: string; title: string }) => void;
}) {
  try {
    if (!shouldGenerateAutomaticThreadTitle(input.prepared)) {
      return;
    }

    const titleTask = input.titleTask ?? input.turnService.generateChatTitle({
      prepared: input.prepared,
      llm: input.llm,
    });
    const generatedTitle = await withTimeout(titleTask, CHAT_TITLE_WAIT_MS);
    if (!generatedTitle) {
      return;
    }

    const titleThread = await input.turnService.applyAutomaticThreadTitle({
      prepared: input.prepared,
      title: generatedTitle,
      expectedTitle: input.prepared.initialTitle,
    });
    if (titleThread) {
      input.yieldTitleUpdate?.({ id: titleThread.id, title: titleThread.title });
    }
  } catch (error) {
    logger.warn("Failed to generate automatic thread title", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

class ContentThreadStreamService {
  constructor(private readonly turnService: ContentThreadTurnService) {}

  async refreshThread(input: RefreshThreadInput) {
    return this.streamThread(await resolveRefreshThreadStreamInput(input));
  }

  async *refreshThreadEvents(input: RefreshThreadInput): AsyncGenerator<string> {
    yield* this.streamThreadEvents(await resolveRefreshThreadStreamInput(input));
  }

  async editThread(input: EditThreadInput) {
    return this.streamThread(await resolveEditThreadStreamInput(input));
  }

  async *editThreadEvents(input: EditThreadInput): AsyncGenerator<string> {
    yield* this.streamThreadEvents(await resolveEditThreadStreamInput(input));
  }

  async *streamThreadEvents(
    input: StreamThreadEventInput,
  ): AsyncGenerator<string> {
    const prepared = await this.turnService.prepareThreadTurn(input);
    const chatStartedAt = Date.now();

    const textId = `text-${prepared.userMessage.id}`;
    yield toSseData({ type: "start", messageId: prepared.userMessage.id });
    yield toSseData({ type: "text-start", id: textId });

    const titleUpdates: Array<{ id: string; title: string }> = [];
    const titleTask = shouldGenerateAutomaticThreadTitle(prepared)
      ? generateAndApplyGeneratedThreadTitle({
          prepared,
          turnService: this.turnService,
          llm: input.llm,
          yieldTitleUpdate: (thread) => titleUpdates.push(thread),
        })
      : null;

    const emitTitleUpdates = function* () {
      while (titleUpdates.length > 0) {
        const update = titleUpdates.shift()!;
        yield toSseData({
          type: "thread-title-update",
          threadId: update.id,
          title: update.title,
        });
      }
    };

    try {
      let outcome: DeepAgentTurnOutcome | null = null;
      const agentEvents = invokeDeepAgentTurn({
        prepared,
        llm: input.llm,
      });
      let nextAgentEvent = agentEvents.next();
      let titleSettled = false;
      let nextTitleEvent: Promise<"title"> | null = titleTask
        ? titleTask.then(() => "title" as const)
        : null;

      while (true) {
        const result = await Promise.race([
          nextAgentEvent.then((value) => ({ type: "agent" as const, value })),
          ...(nextTitleEvent ? [nextTitleEvent.then(() => ({ type: "title" as const }))] : []),
        ]);

        if (result.type === "title") {
          titleSettled = true;
          nextTitleEvent = null;
          yield* emitTitleUpdates();
          continue;
        }

        const { value: event, done } = result.value;
        if (done) {
          break;
        }

        nextAgentEvent = agentEvents.next();
        if (event.type === "done") {
          outcome = event.outcome;
          continue;
        }

        yield mapDeepAgentEventToSse(event, textId);
        yield* emitTitleUpdates();
      }

      if (!titleSettled) {
        await titleTask;
        yield* emitTitleUpdates();
      }

      if (!outcome) {
        throw new ContentError(
          502,
          "MODEL_EMPTY_RESPONSE",
          "Model returned no response",
        );
      }

      const { assistantMessage } =
        await this.turnService.finalizeThreadTurn({
          prepared,
          retrieval: outcome.retrieval,
          citations: outcome.citations,
          retrievalCalls: outcome.retrievalCalls,
          toolCalls: outcome.toolCalls,
          thinkingSteps: outcome.thinkingSteps,
          llm: input.llm,
          operation: "chat.stream",
          assistantContent: outcome.assistantContent,
          usage: outcome.usage,
          finishReason: outcome.finishReason,
          providerFields: outcome.providerFields,
          agentCheckpoint: outcome.agentCheckpoint,
          latencyMs: Date.now() - chatStartedAt,
        });

      yield toSseData({ type: "text-end", id: textId });
      yield toSseData({
        type: "assistant-message",
        messageId: assistantMessage.id,
        userMessageId: prepared.userMessage.id,
        parentMessageId: assistantMessage.parentMessageId,
      });
      if (titleTask) {
        await titleTask;
        yield* emitTitleUpdates();
      }
    } catch (error) {
      const contentError =
        error instanceof ContentError ? error : toContentServiceError(error);

      await recordThreadStreamFailure({
        prepared,
        contentError,
        operation: "chat.stream",
        llm: input.llm,
      });
      const errorAssistantMessage = await createErrorAssistantMessage({
        prepared,
        contentError,
        llm: input.llm,
      });

      yield toSseData({ type: "text-end", id: textId });

      yield toSseData({
        type: "error",
        code: contentError.code,
        error: contentError.message,
        messageId: errorAssistantMessage.id,
        userMessageId: prepared.userMessage.id,
        parentMessageId: errorAssistantMessage.parentMessageId,
      });
    }

    yield toSseData({ type: "finish" });
  }

  async streamThread(input: StreamThreadEventInput) {
    const prepared = await this.turnService.prepareThreadTurn(input);
    const chatStartedAt = Date.now();

    const outcome = await (async () => {
      let doneOutcome: DeepAgentTurnOutcome | null = null;
      for await (const event of invokeDeepAgentTurn({
        prepared,
        llm: input.llm,
      })) {
        if (event.type === "done") {
          doneOutcome = event.outcome;
        }
      }

      if (!doneOutcome) {
        throw new ContentError(
          502,
          "MODEL_EMPTY_RESPONSE",
          "Model returned no response",
        );
      }

      return doneOutcome;
    })().catch(async (error: unknown) => {
      const contentError =
        error instanceof ContentError ? error : toContentServiceError(error);
      await recordThreadStreamFailure({
        prepared,
        contentError,
        operation: "chat.complete",
        llm: input.llm,
      });
      throw contentError;
    });

    const { assistantMessage, billing } =
      await this.turnService.finalizeThreadTurn({
        prepared,
        retrieval: outcome.retrieval,
        citations: outcome.citations,
        retrievalCalls: outcome.retrievalCalls,
        toolCalls: outcome.toolCalls,
        thinkingSteps: outcome.thinkingSteps,
        llm: input.llm,
        operation: "chat.complete",
        assistantContent: outcome.assistantContent,
        usage: outcome.usage,
        finishReason: outcome.finishReason,
        providerFields: outcome.providerFields,
        agentCheckpoint: outcome.agentCheckpoint,
        latencyMs: Date.now() - chatStartedAt,
        modelForMessage: prepared.modelAlias,
      });

    if (shouldGenerateAutomaticThreadTitle(prepared)) {
      await generateAndApplyGeneratedThreadTitle({
        prepared,
        turnService: this.turnService,
        llm: input.llm,
      });
    }

    return {
      thread: prepared.thread,
      userMessage: prepared.userMessage,
      assistantMessage,
      billing,
      retrieval: {
        embeddingProfileId: outcome.retrieval?.profile.id ?? null,
        vectorStrategy: outcome.retrieval?.planner.strategy ?? null,
        annIndexUsed: outcome.retrieval?.planner.annIndexUsed ?? null,
        citations: outcome.citations,
      },
    };
  }
}

export { ContentThreadStreamService };

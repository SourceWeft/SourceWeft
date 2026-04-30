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
  recordThreadStreamFailure,
  rollbackCreatedUserMessage,
} from "./error";
import { toSseData } from "./helpers";
import {
  resolveEditThreadStreamInput,
  resolveRefreshThreadStreamInput,
} from "./input";
import type { EditThreadInput, RefreshThreadInput } from "./types";
import { withTimeout } from "./helpers";

const CHAT_TITLE_STREAM_WAIT_MS = 3000;

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
      logger.debug("Skipped automatic thread title generation", {
        threadId: input.prepared.thread.id,
        userMessageId: input.prepared.userMessage.id,
        isFirstAssistantResponse: input.prepared.isFirstAssistantResponse,
        assistantMessageParentId: input.prepared.assistantMessageParentId,
        initialTitle: input.prepared.initialTitle,
      });
      return;
    }

    logger.debug("Generating automatic thread title", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      modelAlias: input.prepared.modelAlias,
      initialTitle: input.prepared.initialTitle,
    });

    const titleTask = input.titleTask ?? input.turnService.generateChatTitle({
      prepared: input.prepared,
      llm: input.llm,
    });
    const generatedTitle = await titleTask;
    if (!generatedTitle) {
      logger.debug("Automatic thread title generation returned empty title", {
        threadId: input.prepared.thread.id,
        userMessageId: input.prepared.userMessage.id,
      });
      return;
    }

    const titleThread = await input.turnService.applyAutomaticThreadTitle({
      prepared: input.prepared,
      title: generatedTitle,
      expectedTitle: input.prepared.initialTitle,
    });
    if (!titleThread) {
      logger.debug("Automatic thread title was not applied", {
        threadId: input.prepared.thread.id,
        userMessageId: input.prepared.userMessage.id,
        generatedTitle,
        expectedTitle: input.prepared.initialTitle,
      });
      return;
    }

    logger.debug("Applied automatic thread title", {
      threadId: titleThread.id,
      userMessageId: input.prepared.userMessage.id,
      title: titleThread.title,
    });
    input.yieldTitleUpdate?.({ id: titleThread.id, title: titleThread.title });
  } catch (error) {
    logger.warn("Failed to generate automatic thread title", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

async function enqueueAutomaticThreadTitleJob(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
}) {
  if (!shouldGenerateAutomaticThreadTitle(input.prepared)) {
    return;
  }

  const { enqueueThreadTitleGenerateJob } = await import("../../queue");
  await enqueueThreadTitleGenerateJob({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    messageContent: input.prepared.messageContent,
    modelAlias: input.prepared.modelAlias,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    expectedTitle: input.prepared.initialTitle,
  }).catch((error: unknown) => {
    logger.warn("Failed to enqueue automatic thread title job", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

class ContentThreadStreamService {
  constructor(
    private readonly turnService: ContentThreadTurnService,
    private readonly invokeAgentTurn = invokeDeepAgentTurn,
    private readonly enqueueTitleJob = enqueueAutomaticThreadTitleJob,
  ) {}

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
    let titleUpdateEmitted = false;
    void this.enqueueTitleJob({ prepared });
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
        titleUpdateEmitted = true;
        yield toSseData({
          type: "thread-title-update",
          threadId: update.id,
          title: update.title,
        });
      }
    };

    try {
      let outcome: DeepAgentTurnOutcome | null = null;
      const agentEvents = this.invokeAgentTurn({
        prepared,
        llm: input.llm,
      });
      let nextAgentEvent = agentEvents.next();
      let titleSettled = false;
      const titleCompletion: Promise<"title"> | null = titleTask
        ? titleTask.then(() => {
            titleSettled = true;
            return "title" as const;
          })
        : null;
      let nextTitleEvent: Promise<"title"> | null = titleCompletion;

      while (true) {
        const result = await Promise.race([
          nextAgentEvent.then((value) => ({ type: "agent" as const, value })),
          ...(nextTitleEvent ? [nextTitleEvent.then(() => ({ type: "title" as const }))] : []),
        ]);

        if (result.type === "title") {
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
      if (titleTask && !titleSettled) {
        await withTimeout(titleTask, CHAT_TITLE_STREAM_WAIT_MS);
      }
      yield* emitTitleUpdates();
      if (titleTask && !titleUpdateEmitted) {
        yield toSseData({
          type: "thread-title-pending",
          threadId: prepared.thread.id,
        });
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
      await rollbackCreatedUserMessage({ prepared });

      yield toSseData({ type: "text-end", id: textId });

      yield toSseData({
        type: "error",
        code: contentError.code,
        error: contentError.message,
        userMessageId: prepared.userMessage.id,
      });
    }

    yield toSseData({ type: "finish" });
  }

  async streamThread(input: StreamThreadEventInput) {
    const prepared = await this.turnService.prepareThreadTurn(input);
    const chatStartedAt = Date.now();

    const outcome = await (async () => {
      let doneOutcome: DeepAgentTurnOutcome | null = null;
      for await (const event of this.invokeAgentTurn({
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
      await rollbackCreatedUserMessage({ prepared });
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
      void this.enqueueTitleJob({ prepared });
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

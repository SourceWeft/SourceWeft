import { jobsQueue } from "../../../shared/queue";
import { CHAT_RUN_STREAM_TTL_SECONDS } from "./constants";

export type ChatRunStreamEvent = {
  kind: "sse" | "stop";
  payload?: string;
  createdAt: string;
};

function parseStreamEvent(value: string): ChatRunStreamEvent | null {
  try {
    const parsed = JSON.parse(value) as Partial<ChatRunStreamEvent>;
    if (parsed.kind !== "sse" && parsed.kind !== "stop") {
      return null;
    }
    return {
      kind: parsed.kind,
      payload: typeof parsed.payload === "string" ? parsed.payload : undefined,
      createdAt:
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function getRedisClient() {
  return jobsQueue.client;
}

function cancelChannel(runId: string) {
  return `chatrun:cancel:${runId}`;
}

export class ChatRunStreamManager {
  async appendEvent(streamKey: string, payload: string) {
    const client = await getRedisClient();
    const event: ChatRunStreamEvent = {
      kind: "sse",
      payload,
      createdAt: new Date().toISOString(),
    };
    const offset = await client.rpush(streamKey, JSON.stringify(event));
    await client.expire(streamKey, CHAT_RUN_STREAM_TTL_SECONDS);
    return offset;
  }

  async appendStop(streamKey: string) {
    const client = await getRedisClient();
    const event: ChatRunStreamEvent = {
      kind: "stop",
      createdAt: new Date().toISOString(),
    };
    const offset = await client.rpush(streamKey, JSON.stringify(event));
    await client.expire(streamKey, CHAT_RUN_STREAM_TTL_SECONDS);
    return offset;
  }

  async getEvents(streamKey: string, offset: number) {
    const client = await getRedisClient();
    const rawEvents = await client.lrange(streamKey, offset, -1);
    const events = rawEvents
      .map(parseStreamEvent)
      .filter((event): event is ChatRunStreamEvent => event !== null);
    return {
      events,
      nextOffset: offset + rawEvents.length,
    };
  }

  async hasStop(streamKey: string) {
    const { events } = await this.getEvents(streamKey, 0);
    return events.some((event) => event.kind === "stop");
  }

  /**
   * Timely, cross-process cancel delivery. `appendStop` above only pushes a
   * marker onto the stream list that the client-facing SSE reader drains; it
   * never wakes the worker running the turn. Publishing here does: the worker
   * subscribes to this channel and aborts within milliseconds, instead of only
   * discovering the cancel at the next between-events status poll — the gap that
   * let a Stop sit unheard while a long tool ran to completion.
   */
  async publishCancel(runId: string) {
    const client = await getRedisClient();
    await client.publish(cancelChannel(runId), "1");
  }

  /**
   * Subscribes the worker to a run's cancel channel. It uses a dedicated
   * connection because an ioredis client in subscriber mode can no longer issue
   * the ordinary commands the shared queue client is busy with. Returns an
   * unsubscribe that also tears the connection down.
   */
  async subscribeCancel(
    runId: string,
    onCancel: () => void,
  ): Promise<() => Promise<void>> {
    const base = await getRedisClient();
    const subscriber = base.duplicate();
    const channel = cancelChannel(runId);
    const handleMessage = (messageChannel: string) => {
      if (messageChannel === channel) {
        onCancel();
      }
    };
    subscriber.on("message", handleMessage);
    await subscriber.subscribe(channel);
    return async () => {
      subscriber.off("message", handleMessage);
      try {
        await subscriber.unsubscribe(channel);
      } catch {
        // Best-effort: we tear the connection down next regardless.
      }
      subscriber.disconnect();
    };
  }
}

export const chatRunStreamManager = new ChatRunStreamManager();

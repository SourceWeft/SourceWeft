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
}

export const chatRunStreamManager = new ChatRunStreamManager();

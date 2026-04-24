import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config } from "./config";

let saverPromise: Promise<PostgresSaver> | null = null;

export function getChatCheckpointer() {
  if (!saverPromise) {
    saverPromise = (async () => {
      const saver = PostgresSaver.fromConnString(config.databaseUrl, {
        schema: "langgraph",
      });
      await saver.setup();
      return saver;
    })();
  }

  return saverPromise;
}

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { config } from "./config";
import { UniqueVersionPostgresSaver } from "./unique-version-postgres-saver";

let saverPromise: Promise<PostgresSaver> | null = null;

export function getChatCheckpointer() {
  if (!saverPromise) {
    saverPromise = (async () => {
      const saver = new UniqueVersionPostgresSaver(
        new Pool({ connectionString: config.databaseUrl }),
        undefined,
        { schema: "langgraph" },
      );
      await saver.setup();
      return saver;
    })();
  }

  return saverPromise;
}

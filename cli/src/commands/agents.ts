import { AGENTS } from "../install/agents";
import { table } from "../ui";

/** The agents this CLI can install for, and where each keeps its skills. */
export function agentsCommand(ctx: {
  json: boolean;
  out: (line: string) => void;
}): void {
  if (ctx.json) {
    ctx.out(JSON.stringify(AGENTS, null, 2));
    return;
  }
  ctx.out(
    table([
      ["agent", "user directory", "project directory", "also reads .agents"],
      ...AGENTS.map((agent) => [
        agent.id,
        `~/${agent.userDir}`,
        agent.projectDir,
        agent.readsShared ? "yes" : "",
      ]),
    ]),
  );
}

import {
  AGENT_TASK_TICK_LIMIT,
  claimAgentTaskOccurrences,
  dispatchAgentTaskOccurrence,
  listAgentTaskRunsToReconcile,
  materializeAgentTaskSlots,
  recheckBlockedAgentTasks,
  reconcileAgentTaskRun,
} from "../../modules/agent-tasks";
import { runScheduleTick, type ScheduleAdapter } from "../../modules/schedules";

type Reconcilable = Awaited<
  ReturnType<typeof listAgentTaskRunsToReconcile>
>[number];
type Claimed = Awaited<ReturnType<typeof claimAgentTaskOccurrences>>[number];

/**
 * The scheduled-task kind of the shared schedule engine. A due slot becomes
 * an ordinary chat run in a new conversation of the task's owner; the
 * occurrence is the outbox, so a replayed dispatch finds the conversation and
 * run it already made.
 */
export const agentTaskScheduleAdapter: ScheduleAdapter<
  Reconcilable,
  never,
  Claimed
> = {
  label: "agent task",
  limit: AGENT_TASK_TICK_LIMIT,
  // Unused: a silent chat run is failed by the chat run sweep, and reconcile
  // then sees a run that has ended.
  staleAfterMs: 10 * 60_000,

  materialize: ({ now, limit }) => materializeAgentTaskSlots({ now, limit }),

  listQueued: (limit) => listAgentTaskRunsToReconcile(limit),
  reconcileQueued: (item) => reconcileAgentTaskRun(item),

  listStale: async () => [],
  recoverStale: async () => {},

  claim: ({ now, limit }) => claimAgentTaskOccurrences({ now, limit }),
  dispatch: (item) => dispatchAgentTaskOccurrence(item),

  afterTick: (now) => recheckBlockedAgentTasks(now),
};

export async function scheduleAgentTasks() {
  await runScheduleTick(agentTaskScheduleAdapter, new Date());
}

import type {
  AgentTaskResponse,
  AgentTaskRunForThreadResponse,
  CreateAgentTaskRequest,
  ListAgentTaskRunsRequest,
  ListAgentTaskRunsResponse,
  ListAgentTasksResponse,
  PreviewAgentTaskScheduleRequest,
  PreviewAgentTaskScheduleResponse,
  RunAgentTaskNowRequest,
  RunAgentTaskNowResponse,
  UpdateAgentTaskRequest,
} from "@sourceweft/contracts/scheduled-tasks";
import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

/**
 * Scheduled tasks: saved prompts that run as the signed-in person, on a time
 * rule or on demand. Every call acts on that person's own tasks in the given
 * workspace; somebody else's task answers 404.
 */
export class AgentTasksClient {
  constructor(private readonly http: HttpClient) {}

  private base(workspaceId: string) {
    return `/v1/workspaces/${encode(workspaceId)}/agent-tasks`;
  }

  private item(workspaceId: string, taskId: string) {
    return `${this.base(workspaceId)}/${encode(taskId)}`;
  }

  list(workspaceId: string) {
    return this.http.get<ListAgentTasksResponse>(this.base(workspaceId));
  }

  create(workspaceId: string, input: CreateAgentTaskRequest) {
    return this.http.post<AgentTaskResponse>(this.base(workspaceId), input);
  }

  get(workspaceId: string, taskId: string) {
    return this.http.get<AgentTaskResponse>(this.item(workspaceId, taskId));
  }

  /** `input.version` is the version the edit was made against. */
  update(workspaceId: string, taskId: string, input: UpdateAgentTaskRequest) {
    return this.http.patch<AgentTaskResponse>(
      this.item(workspaceId, taskId),
      input,
    );
  }

  /** Archives the task; its run history and conversations stay. */
  delete(workspaceId: string, taskId: string) {
    return this.http.delete<{ deleted: true }>(this.item(workspaceId, taskId));
  }

  pause(workspaceId: string, taskId: string) {
    return this.http.post<AgentTaskResponse>(
      `${this.item(workspaceId, taskId)}/pause`,
    );
  }

  resume(workspaceId: string, taskId: string) {
    return this.http.post<AgentTaskResponse>(
      `${this.item(workspaceId, taskId)}/resume`,
    );
  }

  /** Enables a draft, or a one-time task that has already run. */
  activate(workspaceId: string, taskId: string) {
    return this.http.post<AgentTaskResponse>(
      `${this.item(workspaceId, taskId)}/activate`,
    );
  }

  /**
   * Starts one run now. `idempotencyKey` is minted per click: sending the
   * same key again returns the same run. Answers 429 past the hourly limit.
   */
  runNow(workspaceId: string, taskId: string, input: RunAgentTaskNowRequest) {
    return this.http.post<RunAgentTaskNowResponse>(
      `${this.item(workspaceId, taskId)}/run-now`,
      input,
    );
  }

  /** Run history, newest first, with the reason a slot did not run. */
  listRuns(
    workspaceId: string,
    taskId: string,
    input: ListAgentTaskRunsRequest = {},
  ) {
    const search = new URLSearchParams();
    if (input.limit !== undefined) search.set("limit", String(input.limit));
    if (input.cursor) search.set("cursor", input.cursor);
    const query = search.size ? `?${search.toString()}` : "";
    return this.http.get<ListAgentTaskRunsResponse>(
      `${this.item(workspaceId, taskId)}/runs${query}`,
    );
  }

  /** The scheduled run that made a conversation, with its task; 404 if none. */
  findRunForThread(workspaceId: string, threadId: string) {
    return this.http.get<AgentTaskRunForThreadResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-task-runs/by-thread/${encodeURIComponent(threadId)}`,
    );
  }

  /** The next fire times of a rule, before the task is saved. */
  previewSchedule(workspaceId: string, input: PreviewAgentTaskScheduleRequest) {
    return this.http.post<PreviewAgentTaskScheduleResponse>(
      `${this.base(workspaceId)}/preview-schedule`,
      input,
    );
  }
}

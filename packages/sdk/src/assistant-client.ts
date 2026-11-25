import type {
  AssistantDecisionAction,
  AssistantDecisionsResponse,
  AssistantFeedItemResponse,
  AssistantFeedResponse,
  AssistantResponse,
  AssistantTicket,
  AssistantTicketsResponse,
  PostAssistantMessageRequest,
  TicketActionRequest,
  TicketStage,
  UpdateAssistantRequest,
} from "@sourceweft/contracts/assistants";
import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

/**
 * The workspace assistant: a standing router conversation plus the tickets
 * it spawns. Every call acts on the one assistant belonging to the given
 * workspace.
 */
export class AssistantClient {
  constructor(private readonly http: HttpClient) {}

  private base(workspaceId: string) {
    return `/v1/workspaces/${encode(workspaceId)}/assistant`;
  }

  get(workspaceId: string) {
    return this.http.get<AssistantResponse>(this.base(workspaceId));
  }

  /** Enables the assistant for the workspace; only a container admin may. */
  enable(workspaceId: string) {
    return this.http.post<AssistantResponse>(this.base(workspaceId));
  }

  /** `input.version` is the version the edit was made against. */
  update(workspaceId: string, input: UpdateAssistantRequest) {
    return this.http.patch<AssistantResponse>(this.base(workspaceId), input);
  }

  /** The shared timeline, newest-first page before `before`. */
  listFeed(
    workspaceId: string,
    input: { before?: string; limit?: number } = {},
  ) {
    const search = new URLSearchParams();
    if (input.before) search.set("before", input.before);
    if (input.limit !== undefined) search.set("limit", String(input.limit));
    const query = search.size ? `?${search.toString()}` : "";
    return this.http.get<AssistantFeedResponse>(
      `${this.base(workspaceId)}/feed${query}`,
    );
  }

  /** The router's decisions, newest-first page before `before`. */
  listDecisions(
    workspaceId: string,
    input: {
      before?: string;
      limit?: number;
      action?: AssistantDecisionAction;
    } = {},
  ) {
    const search = new URLSearchParams();
    if (input.before) search.set("before", input.before);
    if (input.limit !== undefined) search.set("limit", String(input.limit));
    if (input.action) search.set("action", input.action);
    const query = search.size ? `?${search.toString()}` : "";
    return this.http.get<AssistantDecisionsResponse>(
      `${this.base(workspaceId)}/decisions${query}`,
    );
  }

  /**
   * Sends a member message to the assistant. `idempotencyKey` is minted per
   * send: sending the same key again replays the same feed item.
   */
  postMessage(workspaceId: string, input: PostAssistantMessageRequest) {
    return this.http.post<AssistantFeedItemResponse>(
      `${this.base(workspaceId)}/messages`,
      input,
    );
  }

  listTickets(workspaceId: string, input: { stage?: TicketStage } = {}) {
    const search = new URLSearchParams();
    if (input.stage) search.set("stage", input.stage);
    const query = search.size ? `?${search.toString()}` : "";
    return this.http.get<AssistantTicketsResponse>(
      `${this.base(workspaceId)}/tickets${query}`,
    );
  }

  closeTicket(
    workspaceId: string,
    ticketId: string,
    input: TicketActionRequest,
  ) {
    return this.http.post<{ ticket: AssistantTicket }>(
      `${this.base(workspaceId)}/tickets/${encode(ticketId)}/close`,
      input,
    );
  }

  /** Routes one more event straight to the ticket, resetting its failure count. */
  retryTicket(
    workspaceId: string,
    ticketId: string,
    input: TicketActionRequest,
  ) {
    return this.http.post<{ ticket: AssistantTicket }>(
      `${this.base(workspaceId)}/tickets/${encode(ticketId)}/retry`,
      input,
    );
  }
}

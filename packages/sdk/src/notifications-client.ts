import type {
  ListNotificationsRequest,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationUnreadCountResponse,
} from "@sourceweft/contracts/notifications";
import { HttpClient } from "./http-client";

/** The signed-in person's inbox in the workspace's team. */
export class NotificationsClient {
  constructor(private readonly http: HttpClient) {}

  private base(workspaceId: string) {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications`;
  }

  list(workspaceId: string, input: ListNotificationsRequest = {}) {
    const search = new URLSearchParams();
    if (input.limit !== undefined) search.set("limit", String(input.limit));
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.unreadOnly) search.set("unreadOnly", "true");
    const query = search.size ? `?${search.toString()}` : "";
    return this.http.get<ListNotificationsResponse>(
      `${this.base(workspaceId)}${query}`,
    );
  }

  unreadCount(workspaceId: string) {
    return this.http.get<NotificationUnreadCountResponse>(
      `${this.base(workspaceId)}/unread-count`,
    );
  }

  markRead(workspaceId: string, id: string) {
    return this.http.post<MarkNotificationsReadResponse>(
      `${this.base(workspaceId)}/${encodeURIComponent(id)}/read`,
    );
  }

  markAllRead(workspaceId: string) {
    return this.http.post<MarkNotificationsReadResponse>(
      `${this.base(workspaceId)}/read-all`,
    );
  }
}

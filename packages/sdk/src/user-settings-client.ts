import type {
  GetUserSettingsResponse,
  UpdateUserSettingsRequest,
  UpdateUserSettingsResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

export class UserSettingsClient {
  constructor(private readonly http: HttpClient) {}

  getSettings() {
    return this.http.get<GetUserSettingsResponse>("/v1/user/settings");
  }

  updateSettings(input: UpdateUserSettingsRequest) {
    return this.http.patch<UpdateUserSettingsResponse>(
      "/v1/user/settings",
      input,
    );
  }
}

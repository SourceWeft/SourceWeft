import {
  deploymentCapabilitiesSchema,
  type DeploymentCapabilities,
} from "@sourceweft/contracts/deployment-capabilities";
import type { HttpClient } from "./http-client";

export class DeploymentClient {
  constructor(private readonly http: HttpClient) {}

  async getCapabilities(): Promise<DeploymentCapabilities> {
    return deploymentCapabilitiesSchema.parse(
      await this.http.get<unknown>("/v1/deployment/capabilities"),
    );
  }
}

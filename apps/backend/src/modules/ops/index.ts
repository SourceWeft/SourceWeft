import { config } from "../../shared/config";
import { OpsAlertService } from "./service";

export const opsAlertService = new OpsAlertService(config.ops);

export * from "./types";

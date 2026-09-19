import { publicRuntimeConfig } from "./public-runtime-config";
export function resolveGoogleOneTapConfig() {
  const config = publicRuntimeConfig();
  return {
    active: config.googleOneTapEnabled && Boolean(config.googleOneTapClientId),
    enabled: config.googleOneTapEnabled,
    clientId: config.googleOneTapClientId,
    fedCmEnabled: config.googleOneTapFedCmEnabled,
  };
}

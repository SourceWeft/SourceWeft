export function resolveGoogleOneTapConfig() {
  const enabled =
    process.env.NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED?.trim().toLowerCase() !==
    "false";
  const clientId =
    process.env.NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID?.trim() || "";
  const fedCmEnabled =
    process.env.NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED?.trim().toLowerCase() ===
    "true";

  return {
    active: enabled && Boolean(clientId),
    clientId,
    enabled,
    fedCmEnabled,
  };
}

import { desktopBridge } from "./desktop-bridge";
import { apiBaseUrl } from "./api-base-url";

type NativeSession = { deviceId: string; proof: string; expiresAt: string };
let session: NativeSession | null = null;
let pending: Promise<NativeSession> | null = null;

/** Credential stays in Keychain. Only a session-bound proof reaches the Web UI. */
export async function ensureLocalHostSession(): Promise<NativeSession | null> {
  if (!desktopBridge.isAvailable()) return null;
  if (session && Date.parse(session.expiresAt) > Date.now() + 60_000)
    return session;
  if (pending) return pending;
  pending = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${apiBaseUrl}/v1/local-devices/enroll`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        session = null;
        throw new Error("本机初始化失败，请确认已登录。");
      }
      const { ticket, userId } = await response.json();
      const value = await desktopBridge.authenticateLocalHost(ticket, userId);
      if (value.needsProof) continue;
      if (!value.deviceId || !value.proof || !value.expiresAt)
        throw new Error("本机未返回有效身份。");
      session = {
        deviceId: value.deviceId,
        proof: value.proof,
        expiresAt: value.expiresAt,
      };
      return session;
    }
    throw new Error("本机登记未完成。");
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function localHostHeaders(): Promise<Record<string, string>> {
  if (
    typeof window === "undefined" ||
    !window.location.pathname.startsWith("/dashboard")
  )
    return {};
  const value = await ensureLocalHostSession();
  return value ? { "X-Local-Proof": value.proof } : {};
}

export function clearLocalHostSession() {
  session = null;
}

export async function disconnectLocalHostSession() {
  session = null;
  if (desktopBridge.isAvailable()) await desktopBridge.disconnectLocalHost();
}

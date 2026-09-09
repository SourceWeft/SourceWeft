import { desktopBridge } from "./desktop-bridge";
import { apiBaseUrl } from "./api-base-url";

type NativeSession = {
  deviceId: string;
  userId: string;
  proof: string;
  expiresAt: string;
};
let session: NativeSession | null = null;
let pending: Promise<NativeSession> | null = null;
let generation = 0;
let initializingUserId: string | undefined;

/** Credential stays in Keychain. A local initialization failure never selects cloud. */
export async function ensureLocalHostSession(
  expectedUserId?: string,
): Promise<NativeSession | null> {
  if (!desktopBridge.isAvailable()) return null;
  if (
    expectedUserId &&
    ((session && session.userId !== expectedUserId) ||
      (pending && initializingUserId !== expectedUserId))
  )
    await disconnectLocalHostSession();
  if (session && Date.parse(session.expiresAt) > Date.now() + 60_000)
    return session;
  if (pending) return pending;
  const status = await desktopBridge.localHostStatus();
  if (!status.platformSupported) return null;
  if (status.protocolVersion !== 2)
    throw new Error("请更新 PC 客户端后使用本机能力。");
  if (pending) return ensureLocalHostSession(expectedUserId);
  const startedGeneration = generation;
  initializingUserId = expectedUserId;
  const attempt = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${apiBaseUrl}/v1/local-devices/enroll`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("本机初始化失败，请确认已登录。");
      const { ticket, userId } = await response.json();
      if (
        startedGeneration !== generation ||
        (expectedUserId && userId !== expectedUserId)
      )
        throw new Error("登录账号已变化，请重试。");
      const value = await desktopBridge.authenticateLocalHost(ticket, userId);
      if (startedGeneration !== generation) throw new Error("本机登录已结束。");
      if (value.needsProof) continue;
      if (!value.deviceId || !value.proof || !value.expiresAt)
        throw new Error("本机未返回有效身份。");
      session = {
        deviceId: value.deviceId,
        userId,
        proof: value.proof,
        expiresAt: value.expiresAt,
      };
      return session;
    }
    throw new Error("本机登记未完成。");
  })();
  pending = attempt;
  void attempt.then(
    () => {
      if (pending === attempt) pending = null;
    },
    () => {
      if (pending === attempt) pending = null;
    },
  );
  return attempt;
}

/** Ordinary catalog/history/cloud calls must not wait for Keychain. */
export async function cachedLocalHostHeaders(
  path?: string,
): Promise<Record<string, string>> {
  if (path && !/^\/v1\/workspaces\/[^/]+\/threads(?:\/start-turn)?$/.test(path))
    return {};
  return typeof window !== "undefined" &&
    window.location.pathname.startsWith("/dashboard") &&
    session &&
    Date.parse(session.expiresAt) > Date.now()
    ? { "X-Local-Proof": session.proof }
    : {};
}
export async function localHostHeaders(thread?: {
  workspaceId: string;
  threadId: string;
}): Promise<Record<string, string>> {
  if (
    typeof window === "undefined" ||
    !window.location.pathname.startsWith("/dashboard") ||
    !desktopBridge.isAvailable()
  )
    return {};
  let threadUserId: string | undefined;
  if (thread) {
    const response = await fetch(
      `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(thread.workspaceId)}/threads/${encodeURIComponent(thread.threadId)}/local-execution`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error("无法确认对话的工作环境。");
    const info = await response.json();
    if (info.executionTarget?.kind === "cloud") return {};
    if (typeof info.userId !== "string")
      throw new Error("无法确认本机对话的登录账号。");
    threadUserId = info.userId;
  }
  const value = await ensureLocalHostSession(threadUserId);
  return value ? { "X-Local-Proof": value.proof } : {};
}
export function clearLocalHostSession() {
  generation++;
  session = null;
  pending = null;
  initializingUserId = undefined;
}
export async function disconnectLocalHostSession() {
  clearLocalHostSession();
  if (
    desktopBridge.isAvailable() &&
    (await desktopBridge.localHostStatus()).platformSupported
  )
    await desktopBridge.disconnectLocalHost();
}

let authenticatedScope: string | null = null;
/** Clear a proof before child effects can use a different account/session cookie. */
export async function synchronizeLocalHostScope(
  userId?: string,
  sessionId?: string,
) {
  const next = userId && sessionId ? `${userId}:${sessionId}` : null;
  if (next === authenticatedScope) return;
  const previous = authenticatedScope;
  authenticatedScope = next;
  if (previous !== null) await disconnectLocalHostSession();
  if (next !== null && authenticatedScope === next)
    await ensureLocalHostSession(userId);
}

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
    throw new Error("Update the PC app to use local features.");
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
      if (!response.ok)
        throw new Error(
          "Could not initialize this computer. Check that you are signed in.",
        );
      const { ticket, userId } = await response.json();
      if (
        startedGeneration !== generation ||
        (expectedUserId && userId !== expectedUserId)
      )
        throw new Error("Your account changed. Try again.");
      const value = await desktopBridge.authenticateLocalHost(ticket, userId);
      if (startedGeneration !== generation)
        throw new Error("The local session has ended.");
      if (value.needsProof) continue;
      if (!value.deviceId || !value.proof || !value.expiresAt)
        throw new Error("This computer did not return a valid identity.");
      session = {
        deviceId: value.deviceId,
        userId,
        proof: value.proof,
        expiresAt: value.expiresAt,
      };
      return session;
    }
    throw new Error("Computer setup is incomplete.");
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
  if (
    path &&
    !/^\/v1\/local-devices\/[^/]+\/folders(?:\/[^/]+\/files)?(?:\?.*)?$/.test(
      path,
    ) &&
    !/^\/v1\/workspaces\/[^/]+\/(?:threads(?:\/start-turn|\/[^/]+\/(?:local-files|local-execution))?|agent-confirmations\/[^/]+\/respond)(?:\?.*)?$/.test(
      path,
    )
  )
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
    if (!response.ok)
      throw new Error("Could not verify the conversation environment.");
    const info = await response.json();
    if (info.executionTarget?.kind === "cloud") return {};
    if (typeof info.userId !== "string")
      throw new Error(
        "Could not verify the account for this local conversation.",
      );
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
  // The auxiliary Hub shares web authentication but never owns native host
  // enrollment, proof rotation, or disconnection. These belong to main.
  if (
    typeof window !== "undefined" &&
    ["/dashboard/hub-window", "/dashboard/preview-window"].includes(
      window.location.pathname,
    )
  )
    return;
  const next = userId && sessionId ? `${userId}:${sessionId}` : null;
  if (next === authenticatedScope) return;
  const previous = authenticatedScope;
  authenticatedScope = next;
  if (previous !== null) await disconnectLocalHostSession();
  if (next !== null && authenticatedScope === next)
    await ensureLocalHostSession(userId);
}

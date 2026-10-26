import {
  ARTIFACT_BRIDGE_MESSAGE_BYTES,
  ARTIFACT_BRIDGE_VERSION,
  ARTIFACT_STORAGE_WELCOME,
  ArtifactRecordTransportError,
  artifactBridgeRequestSchema,
  artifactNavigationOpenSchema,
  artifactStorageHelloSchema,
  parseArtifactExternalUrl,
  type ArtifactBridgeResponse,
  type ArtifactRecordErrorCode,
  type ArtifactRecordsTransport,
} from "@sourceweft/contracts/artifact-records";

/**
 * The host end of the artifact page bridge, one per rendered iframe document.
 *
 * Everything arriving here is from an untrusted page. A message counts only
 * when it comes from this iframe's own window, from an opaque origin (the
 * sandbox), and from the first document the iframe loaded: once the frame
 * navigates anywhere, the bridge closes for good and the host must remount
 * the iframe to reconnect. The storage handshake happens once, after which
 * requests travel only on the MessagePort handed to that document. The page
 * never names the artifact or version; the transport is already bound to
 * them.
 */
export class ArtifactBridgeHost {
  private port: MessagePort | null = null;
  private loads = 0;
  private closed = false;
  private reported = false;
  private windowStartedAt = 0;
  private windowCount = 0;

  constructor(
    private readonly options: {
      frameWindow: () => Window | null;
      /** Read per request, so the host can swap transports without a reconnect. */
      transport: () => ArtifactRecordsTransport | null;
      onOpenLink: (url: URL) => void;
      requestsPerSecond?: number;
      now?: () => number;
      createChannel?: () => MessageChannel;
    },
  ) {}

  /** Install as the window `message` listener while the iframe is mounted. */
  handleMessage(event: MessageEvent) {
    if (this.closed || this.loads > 1) return;
    const frame = this.options.frameWindow();
    if (!frame || event.source !== frame || event.origin !== "null") return;
    if (!withinBridgeSize(event.data)) return;
    if (artifactStorageHelloSchema.safeParse(event.data).success) {
      this.open(frame);
      return;
    }
    const link = artifactNavigationOpenSchema.safeParse(event.data);
    if (!link.success) return;
    const url = parseArtifactExternalUrl(link.data.url);
    if (url) this.options.onOpenLink(url);
  }

  /** Call from the iframe's `load`; any load after the first is a navigation. */
  frameLoaded(): "first" | "navigated" {
    this.loads++;
    if (this.loads === 1) return "first";
    this.close();
    return "navigated";
  }

  /**
   * Tell the backend, once per document, that the page tried to leave its
   * frame. Fire-and-forget and advisory: no failure reaches the caller, and
   * nothing from the page (not even the destination) is sent.
   */
  reportNavigation() {
    if (this.reported) return;
    this.reported = true;
    const report = this.options.transport()?.reportNavigation;
    if (!report) return;
    try {
      void Promise.resolve(report()).catch(() => undefined);
    } catch {
      // A throwing transport must not disturb the disconnect.
    }
  }

  close() {
    this.closed = true;
    this.port?.close();
    this.port = null;
  }

  private open(frame: Window) {
    if (this.port) return;
    const channel = this.options.createChannel?.() ?? new MessageChannel();
    this.port = channel.port1;
    const port = channel.port1;
    port.onmessage = (event) => {
      void this.handleRequest(port, event.data);
    };
    // The frame's origin is opaque, so "*" is the only possible target; the
    // message carries nothing but the port bound to this document.
    frame.postMessage(
      { type: ARTIFACT_STORAGE_WELCOME, v: ARTIFACT_BRIDGE_VERSION },
      "*",
      [channel.port2],
    );
  }

  private takeRequestSlot() {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.windowStartedAt >= 1000) {
      this.windowStartedAt = now;
      this.windowCount = 0;
    }
    this.windowCount++;
    return this.windowCount <= (this.options.requestsPerSecond ?? 20);
  }

  private async handleRequest(port: MessagePort, data: unknown) {
    if (this.port !== port) return;
    const requestId = requestIdOf(data);
    if (requestId === null) return;
    const reply = (response: ArtifactBridgeResponse) => {
      if (this.port === port) port.postMessage(response);
    };
    const fail = (code: ArtifactRecordErrorCode, message: string) =>
      reply({ requestId, ok: false, error: { code, message } });
    if (!withinBridgeSize(data))
      return fail("invalid_request", "The request is too large");
    const parsed = artifactBridgeRequestSchema.safeParse(data);
    if (!parsed.success)
      return fail("invalid_request", "The storage request is not valid");
    if (!this.takeRequestSlot())
      return fail("rate_limited", "Too many storage requests; slow down");
    const transport = this.options.transport();
    if (!transport) return fail("unavailable", "Storage is not available here");
    try {
      reply({
        requestId,
        ok: true,
        result: await transport.execute(parsed.data.operation),
      });
    } catch (error) {
      if (error instanceof ArtifactRecordTransportError)
        return fail(error.code, error.message);
      fail("unavailable", "Storage is temporarily unavailable");
    }
  }
}

function requestIdOf(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as { requestId?: unknown }).requestId;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function withinBridgeSize(data: unknown) {
  try {
    const text = JSON.stringify(data);
    return text !== undefined && text.length <= ARTIFACT_BRIDGE_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

/** The iframe URL that asks the host for the injected runtime. */
export function artifactRuntimeUrl(fileUrl: string) {
  const [path, hash] = fileUrl.split("#", 2);
  const separator = path!.includes("?") ? "&" : "?";
  return `${path}${separator}runtime=1${hash === undefined ? "" : `#${hash}`}`;
}

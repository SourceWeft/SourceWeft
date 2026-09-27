"use client";

import { publicRuntimeConfig } from "../public-runtime-config";
import {
  validateEvent,
  type AnalyticsEventName,
  type AnalyticsValue,
  type EventParams,
} from "./catalog";
import { resolveAnalyticsContext, type AnalyticsContext } from "./context";
import { createGtmDestination } from "./destinations/gtm";
import type { AnalyticsDestination, DestinationId } from "./destinations/types";

type Params = Record<string, AnalyticsValue>;
type PendingEvent = { name: string; params: Params };

// Bounds memory when a destination never becomes ready (e.g. an ad blocker
// stops its script); the oldest events are dropped first.
const MAX_QUEUED_EVENTS = 100;

export type AnalyticsClient = {
  track(name: string, params?: Params): void;
  notifyReady(id: DestinationId): void;
};

export type AnalyticsRuntimeConfig = {
  gtmId?: string;
  umami?: { scriptUrl: string; websiteId: string };
};

type Channel = {
  destination: AnalyticsDestination;
  queue: PendingEvent[];
  contextSent: boolean;
};

function withoutUndefined(params: Params): Params {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

function safely(action: () => void) {
  try {
    action();
  } catch (error) {
    console.warn("[analytics] destination call failed", error);
  }
}

export function createAnalyticsClient(options: {
  destinations: AnalyticsDestination[];
  resolveContext: () => Promise<AnalyticsContext>;
  strict: boolean;
  consent?: () => { analytics: boolean };
}): AnalyticsClient {
  const channels: Channel[] = options.destinations.map((destination) => ({
    destination,
    queue: [],
    contextSent: false,
  }));
  const consent = options.consent ?? (() => ({ analytics: true }));
  let context: AnalyticsContext | null = null;

  function gated(channel: Channel) {
    return channel.destination.requiresConsent && !consent().analytics;
  }

  // Context goes out as soon as a destination is ready, not with its first
  // event, so page views the tool records on its own carry the platform too.
  function flush(channel: Channel) {
    if (!context || gated(channel) || !channel.destination.isReady()) {
      return;
    }
    const ctx = context;
    if (!channel.contextSent) {
      channel.contextSent = true;
      safely(() => channel.destination.setContext(ctx));
    }
    while (channel.queue.length > 0) {
      const event = channel.queue.shift()!;
      safely(() =>
        channel.destination.track(event.name, { ...event.params, ...ctx }),
      );
    }
  }

  void options
    .resolveContext()
    .catch((): AnalyticsContext => ({ platform: "web" }))
    .then((resolved) => {
      context = resolved;
      channels.forEach(flush);
    });

  return {
    track(name, params = {}) {
      const cleaned = withoutUndefined(params);
      const error = validateEvent(name, cleaned);
      if (error) {
        if (options.strict) {
          throw new Error(error);
        }
        console.warn(`[analytics] dropped event: ${error}`);
        return;
      }
      for (const channel of channels) {
        if (gated(channel)) {
          continue;
        }
        if (channel.queue.length >= MAX_QUEUED_EVENTS) {
          channel.queue.shift();
          console.warn(
            `[analytics] ${channel.destination.id} queue full; dropped the oldest event`,
          );
        }
        channel.queue.push({ name, params: cleaned });
        flush(channel);
      }
    },
    notifyReady(id) {
      channels.filter((c) => c.destination.id === id).forEach(flush);
    },
  };
}

export function buildDestinations(
  config: AnalyticsRuntimeConfig,
): AnalyticsDestination[] {
  const destinations: AnalyticsDestination[] = [];
  if (config.gtmId) {
    destinations.push(createGtmDestination());
  }
  return destinations;
}

let singleton: AnalyticsClient | null = null;

function analyticsClient(): AnalyticsClient {
  singleton ??= createAnalyticsClient({
    destinations: buildDestinations({ gtmId: publicRuntimeConfig().gtmId }),
    resolveContext: resolveAnalyticsContext,
    strict: process.env.NODE_ENV !== "production",
  });
  return singleton;
}

export function trackEvent<N extends AnalyticsEventName>(
  name: N,
  params?: EventParams<N>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  analyticsClient().track(name, params as Params | undefined);
}

export function markDestinationReady(id: DestinationId): void {
  if (typeof window === "undefined") {
    return;
  }
  analyticsClient().notifyReady(id);
}

export function resetAnalyticsForTests(): void {
  singleton = null;
}

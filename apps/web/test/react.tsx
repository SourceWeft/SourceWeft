import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

// Shared harness for component tests. It does not pick a DOM: every file that
// mounts keeps its own `// @vitest-environment jsdom` directive.

type IntlProps = ComponentProps<typeof NextIntlClientProvider>;

/** The English catalog, typed the way the provider wants it. */
export const messages = en as IntlProps["messages"];

export type IntlOptions = {
  locale?: string;
  messages?: IntlProps["messages"];
  timeZone?: string;
};

export function withIntl(
  node: ReactNode,
  { locale = "en", messages: catalog = messages, timeZone }: IntlOptions = {},
): ReactElement {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={catalog}
      timeZone={timeZone}
    >
      {node}
    </NextIntlClientProvider>
  );
}

export type Mounted = {
  container: HTMLDivElement;
  root: Root;
  /** Render another element into the same root, inside act. */
  render: (node: ReactNode) => Promise<void>;
  /** Unmount inside act and drop the container. Safe to call twice. */
  unmount: () => Promise<void>;
};

const mounted = new Set<Mounted>();

/**
 * Mount into a fresh container attached to document.body, rendering inside
 * an async act so effects and already-resolved promises have run by the time
 * this returns. Tests that need later async work to settle call flush().
 */
export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: ReactNode) => act(async () => root.render(next));
  const handle: Mounted = {
    container,
    root,
    render,
    async unmount() {
      if (!mounted.delete(handle)) return;
      await act(async () => root.unmount());
      container.remove();
    },
  };
  mounted.add(handle);
  await render(node);
  return handle;
}

export function mountWithIntl(node: ReactNode, options?: IntlOptions) {
  return mount(withIntl(node, options));
}

/** Unmount everything still mounted; register with `afterEach(unmountAll)`. */
export async function unmountAll() {
  for (const handle of [...mounted]) await handle.unmount();
}

/** Drain microtasks inside act; raise `rounds` for chains of awaits. */
export function flush(rounds = 1) {
  return act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

export function click(node: HTMLElement) {
  return act(async () => node.click());
}

/** Buttons whose trimmed text equals `label`, in document order. */
export function buttons(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].filter(
    (node) => node.textContent?.trim() === label,
  );
}

export function button(label: string, scope?: ParentNode) {
  return buttons(label, scope)[0]!;
}

/**
 * Set a controlled input's value the way a user would: through the native
 * setter (so React's value tracker notices) followed by an input event.
 */
export function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

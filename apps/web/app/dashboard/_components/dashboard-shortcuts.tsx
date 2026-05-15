"use client";

import * as React from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@sourceweft/ui-web/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";

export type DashboardShortcutKey = {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type DashboardShortcutDefinition = {
  id: string;
  title: string;
  group: string;
  keys: DashboardShortcutKey;
  disabled?: boolean;
  onRun: () => void;
};

export type DashboardShortcutPlatform = "mac" | "default";

export const DASHBOARD_WORKSPACE_SHORTCUT_LIMIT = 9;

const OVERLAY_SELECTOR = [
  "[data-slot='dialog-content']",
  "[data-slot='sheet-content']",
  "[data-slot='popover-content']",
  "[data-slot='dropdown-menu-content']",
].join(",");

function normalizeKey(key: string) {
  return key.toLowerCase();
}

function detectShortcutPlatform(): DashboardShortcutPlatform {
  if (typeof window === "undefined") {
    return "mac";
  }

  return /Mac|iPhone|iPad|iPod/.test(window.navigator.platform)
    ? "mac"
    : "default";
}

export function useDashboardShortcutPlatform() {
  const [platform, setPlatform] =
    React.useState<DashboardShortcutPlatform>("mac");

  React.useEffect(() => {
    setPlatform(detectShortcutPlatform());
  }, []);

  return platform;
}

export function getDashboardWorkspaceShortcutKeys(
  index: number,
  platform: DashboardShortcutPlatform,
): DashboardShortcutKey {
  return {
    key: String(index + 1),
    ...(platform === "mac" ? { meta: true } : { ctrl: true }),
  };
}

function eventMatchesShortcut(
  event: KeyboardEvent,
  shortcut: DashboardShortcutKey,
) {
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) {
    return false;
  }

  if (Boolean(shortcut.ctrl) !== event.ctrlKey) {
    return false;
  }

  if (Boolean(shortcut.meta) !== event.metaKey) {
    return false;
  }

  if (Boolean(shortcut.shift) !== event.shiftKey) {
    return false;
  }

  if (Boolean(shortcut.alt) !== event.altKey) {
    return false;
  }

  return true;
}

function eventShouldPauseShortcuts(event: KeyboardEvent) {
  if (document.querySelector(OVERLAY_SELECTOR)) {
    return true;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest(OVERLAY_SELECTOR));
}

export function formatDashboardShortcut(keys: DashboardShortcutKey) {
  if (keys.meta && !keys.ctrl && !keys.shift && !keys.alt) {
    return `⌘${keys.key.toUpperCase()}`;
  }

  const parts: string[] = [];

  if (keys.meta) {
    parts.push("⌘");
  }

  if (keys.ctrl) {
    parts.push("Ctrl");
  }

  if (keys.shift) {
    parts.push("Shift");
  }

  if (keys.alt) {
    parts.push("Alt");
  }

  parts.push(keys.key.toUpperCase());

  return parts.join("+");
}

export function useDashboardShortcuts(
  definitions: DashboardShortcutDefinition[],
) {
  const definitionsRef = React.useRef(definitions);

  React.useEffect(() => {
    definitionsRef.current = definitions;
  }, [definitions]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        eventShouldPauseShortcuts(event)
      ) {
        return;
      }

      const matched = definitionsRef.current.find(
        (definition) =>
          !definition.disabled && eventMatchesShortcut(event, definition.keys),
      );

      if (!matched) {
        return;
      }

      event.preventDefault();
      matched.onRun();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

export function DashboardShortcutsDialog({
  definitions,
  onOpenChange,
  open,
}: {
  definitions: DashboardShortcutDefinition[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const enabledDefinitions = definitions.filter(
    (definition) => !definition.disabled,
  );
  const groups = Array.from(
    enabledDefinitions.reduce((value, definition) => {
      const group = value.get(definition.group) ?? [];
      group.push(definition);
      value.set(definition.group, group);
      return value;
    }, new Map<string, DashboardShortcutDefinition[]>()),
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Quick actions available in the chat workspace.
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-none">
          <CommandInput placeholder="Search shortcuts..." />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No shortcuts found.</CommandEmpty>
            {groups.map(([group, items]) => (
              <CommandGroup heading={group} key={group}>
                {items.map((definition) => (
                  <CommandItem key={definition.id} value={definition.title}>
                    <span className="min-w-0 flex-1 truncate">
                      {definition.title}
                    </span>
                    <CommandShortcut>
                      {formatDashboardShortcut(definition.keys)}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

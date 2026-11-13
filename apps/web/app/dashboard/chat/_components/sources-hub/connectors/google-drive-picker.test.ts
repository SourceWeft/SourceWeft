// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const SCRIPT_SRC = "https://apis.google.com/js/api.js";

type PickerCallback = (data: Record<string, unknown>) => void;

let capturedCallback: PickerCallback | null = null;
let capturedOAuthToken: string | null = null;

/** Minimal stand-in for `window.google.picker`, mirroring only the fields the
 * wrapper reads. The builder captures the callback and OAuth token so the test
 * can drive the picker result and assert the token is passed as an argument. */
function installGooglePickerStub() {
  class DocsView {
    setIncludeFolders() {
      return this;
    }
    setSelectFolderEnabled() {
      return this;
    }
    setMimeTypes() {
      return this;
    }
  }
  class PickerBuilder {
    private callback: PickerCallback = () => {};
    enableFeature() {
      return this;
    }
    setAppId() {
      return this;
    }
    setOAuthToken(token: string) {
      capturedOAuthToken = token;
      return this;
    }
    setOrigin() {
      return this;
    }
    addView() {
      return this;
    }
    setCallback(callback: PickerCallback) {
      this.callback = callback;
      return this;
    }
    build() {
      capturedCallback = this.callback;
      return { setVisible() {} };
    }
  }
  (globalThis as Record<string, unknown>).google = {
    picker: {
      DocsView,
      PickerBuilder,
      Feature: { MULTISELECT_ENABLED: "multiselect", SUPPORT_DRIVES: "drives" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Response: { ACTION: "action", DOCUMENTS: "docs" },
      Document: { ID: "id" },
    },
  };
}

type GapiLoadConfig = {
  callback?: () => void;
  onerror?: () => void;
  timeout?: number;
  ontimeout?: () => void;
};

function installGapi(load: (name: string, config: GapiLoadConfig) => void) {
  (globalThis as Record<string, unknown>).gapi = { load };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const session = {
  accessToken: "ya29.secret-token",
  appId: "app-123",
  mimeTypes: ["application/pdf", "text/plain"],
};

beforeEach(() => {
  vi.resetModules();
  capturedCallback = null;
  capturedOAuthToken = null;
  delete (globalThis as Record<string, unknown>).gapi;
  delete (globalThis as Record<string, unknown>).google;
  document.head
    .querySelectorAll(`script[src="${SCRIPT_SRC}"]`)
    .forEach((node) => node.remove());
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).gapi;
  delete (globalThis as Record<string, unknown>).google;
});

test("injects the api script only once and resolves cancel with []", async () => {
  const { openGoogleDrivePicker } = await import("./google-drive-picker");

  const first = openGoogleDrivePicker(session);
  const scripts = document.head.querySelectorAll(`script[src="${SCRIPT_SRC}"]`);
  expect(scripts).toHaveLength(1);
  const script = scripts[0];
  if (!script) throw new Error("expected the api script to be injected");

  // The injected script "loads" and defines gapi + the picker namespace.
  installGapi((_name, config) => config.callback?.());
  installGooglePickerStub();
  script.dispatchEvent(new Event("load"));
  await flush();

  capturedCallback?.({ action: "cancel" });
  await expect(first).resolves.toEqual([]);

  // A second open must not inject another script.
  const second = openGoogleDrivePicker(session);
  await flush();
  expect(
    document.head.querySelectorAll(`script[src="${SCRIPT_SRC}"]`),
  ).toHaveLength(1);
  capturedCallback?.({ action: "cancel" });
  await expect(second).resolves.toEqual([]);
});

test("resolves picked documents to their ids and passes the token as an argument", async () => {
  installGapi((_name, config) => config.callback?.());
  installGooglePickerStub();
  const { openGoogleDrivePicker } = await import("./google-drive-picker");

  const promise = openGoogleDrivePicker(session);
  await flush();
  capturedCallback?.({
    action: "picked",
    docs: [{ id: "a" }, { id: "b" }, { id: "" }, {}],
  });

  await expect(promise).resolves.toEqual(["a", "b"]);
  expect(capturedOAuthToken).toBe(session.accessToken);
  // The token must not leak into browser storage.
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

test("rejects when the api script fails to load", async () => {
  const { openGoogleDrivePicker } = await import("./google-drive-picker");

  const promise = openGoogleDrivePicker(session);
  const script = document.head.querySelector(`script[src="${SCRIPT_SRC}"]`);
  script?.dispatchEvent(new Event("error"));

  await expect(promise).rejects.toThrow();
});

test("rejects when gapi.load reports an error", async () => {
  installGapi((_name, config) => config.onerror?.());
  const { openGoogleDrivePicker } = await import("./google-drive-picker");

  await expect(openGoogleDrivePicker(session)).rejects.toThrow();
});

test("rejects when the picker library never finishes loading", async () => {
  vi.useFakeTimers();
  try {
    // gapi is present, but `load` never calls back, so only the timeout
    // backstop can settle the promise.
    installGapi(() => {});
    const { openGoogleDrivePicker } = await import("./google-drive-picker");

    const promise = openGoogleDrivePicker(session);
    const assertion = expect(promise).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

/** Adds the two top-level nodes the Google script appends to `document.body`. */
function mountPickerNodes() {
  const backdrop = document.createElement("div");
  backdrop.className = "picker-dialog-bg";
  const dialog = document.createElement("div");
  dialog.className = "picker picker-dialog";
  const frame = document.createElement("iframe");
  dialog.appendChild(frame);
  document.body.append(backdrop, dialog);
  return { backdrop, dialog, frame };
}

async function openStubbedPicker() {
  installGapi((_name, config) => config.callback?.());
  installGooglePickerStub();
  const pickerModule = await import("./google-drive-picker");
  const promise = pickerModule.openGoogleDrivePicker(session);
  await flush();
  return { pickerModule, promise };
}

test("recognises nodes that belong to the picker", async () => {
  const { isGoogleDrivePickerElement } = await import("./google-drive-picker");
  const { backdrop, dialog, frame } = mountPickerNodes();
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  try {
    expect(isGoogleDrivePickerElement(frame)).toBe(true);
    expect(isGoogleDrivePickerElement(dialog)).toBe(true);
    expect(isGoogleDrivePickerElement(backdrop)).toBe(true);
    expect(isGoogleDrivePickerElement(outside)).toBe(false);
    expect(isGoogleDrivePickerElement(null)).toBe(false);
    expect(isGoogleDrivePickerElement(document)).toBe(false);
  } finally {
    backdrop.remove();
    dialog.remove();
    outside.remove();
  }
});

test("keeps focus moves into the picker away from page-level focus traps while it is open", async () => {
  const { backdrop, dialog, frame } = mountPickerNodes();
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  // Stand-in for a modal dialog's focus trap: bubble-phase document listeners.
  const trapFocusIn = vi.fn();
  const trapFocusOut = vi.fn();
  document.addEventListener("focusin", trapFocusIn);
  document.addEventListener("focusout", trapFocusOut);
  try {
    const { promise } = await openStubbedPicker();

    frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    outside.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: frame }),
    );
    expect(trapFocusIn).not.toHaveBeenCalled();
    expect(trapFocusOut).not.toHaveBeenCalled();

    // Focus moves that do not involve the picker still reach the trap.
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    outside.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    expect(trapFocusIn).toHaveBeenCalledTimes(1);
    expect(trapFocusOut).toHaveBeenCalledTimes(1);

    capturedCallback?.({ action: "cancel" });
    await promise;
  } finally {
    document.removeEventListener("focusin", trapFocusIn);
    document.removeEventListener("focusout", trapFocusOut);
    backdrop.remove();
    dialog.remove();
    outside.remove();
  }
});

test("stops shielding focus events once the picker closes", async () => {
  const { backdrop, dialog, frame } = mountPickerNodes();
  const trapFocusIn = vi.fn();
  document.addEventListener("focusin", trapFocusIn);
  try {
    for (const action of ["cancel", "picked"]) {
      trapFocusIn.mockClear();
      const { promise } = await openStubbedPicker();
      capturedCallback?.({ action, docs: [] });
      await promise;

      frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(trapFocusIn).toHaveBeenCalledTimes(1);
    }
  } finally {
    document.removeEventListener("focusin", trapFocusIn);
    backdrop.remove();
    dialog.remove();
  }
});

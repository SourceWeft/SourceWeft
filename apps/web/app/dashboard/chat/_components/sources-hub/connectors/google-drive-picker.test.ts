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
    setDeveloperKey() {
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
  developerKey: "dev-key",
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

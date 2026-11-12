/**
 * Thin browser-only wrapper around the Google Picker API. The Google script has
 * no npm package, so it is injected at runtime (once) from the official CDN and
 * the `picker` module is loaded through `gapi.load`.
 *
 * Token hygiene: the OAuth access token is handed to the picker as a function
 * argument only. It is never written to a module-level variable, a ref, storage,
 * a URL, a log, or an error. A fresh session (and therefore a fresh token) is
 * requested by the caller on every "Add files" click; this module keeps nothing
 * about a session between calls except the fact that the API script was loaded.
 */

const GOOGLE_API_SCRIPT_SRC = "https://apis.google.com/js/api.js";
const PICKER_LOAD_TIMEOUT_MS = 15000;

export type GoogleDrivePickerSessionInput = {
  accessToken: string;
  appId: string;
  developerKey: string;
  mimeTypes: string[];
};

type GapiLoadConfig = {
  callback?: () => void;
  onerror?: () => void;
  timeout?: number;
  ontimeout?: () => void;
};

type GapiGlobal = {
  load: (name: string, config: GapiLoadConfig | (() => void)) => void;
};

type DocsViewLike = {
  setIncludeFolders: (include: boolean) => DocsViewLike;
  setSelectFolderEnabled: (enabled: boolean) => DocsViewLike;
  setMimeTypes: (mimeTypes: string) => DocsViewLike;
};

type PickerLike = { setVisible: (visible: boolean) => void };

type PickerBuilderLike = {
  enableFeature: (feature: unknown) => PickerBuilderLike;
  setAppId: (appId: string) => PickerBuilderLike;
  setOAuthToken: (token: string) => PickerBuilderLike;
  setDeveloperKey: (key: string) => PickerBuilderLike;
  setOrigin: (origin: string) => PickerBuilderLike;
  addView: (view: unknown) => PickerBuilderLike;
  setCallback: (
    callback: (data: Record<string, unknown>) => void,
  ) => PickerBuilderLike;
  build: () => PickerLike;
};

type GooglePickerNamespace = {
  DocsView: new () => DocsViewLike;
  PickerBuilder: new () => PickerBuilderLike;
  Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
};

type GoogleGlobal = { picker?: GooglePickerNamespace };

function getGapi(): GapiGlobal | undefined {
  return (globalThis as { gapi?: GapiGlobal }).gapi;
}

function getGooglePicker(): GooglePickerNamespace | undefined {
  return (globalThis as { google?: GoogleGlobal }).google?.picker;
}

// Memoises the one-time script injection so a second call never adds a second
// <script>. Reset to null on failure so a later click can retry cleanly.
let scriptLoadPromise: Promise<void> | null = null;

function loadGoogleApiScript(): Promise<void> {
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("google_api_document_unavailable"));
      return;
    }
    if (getGapi()) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_API_SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("google_api_script_failed")),
      { once: true },
    );
    if (!existing) {
      script.src = GOOGLE_API_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    scriptLoadPromise = null;
    throw error instanceof Error ? error : new Error("google_api_script_failed");
  });
  return scriptLoadPromise;
}

function loadPickerModule(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const gapi = getGapi();
    if (!gapi || typeof gapi.load !== "function") {
      reject(new Error("google_api_unavailable"));
      return;
    }
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    // Backstop in case gapi.load never calls back at all, so the returned
    // promise is never left pending.
    const timer = setTimeout(
      () => finish(() => reject(new Error("google_picker_load_timeout"))),
      PICKER_LOAD_TIMEOUT_MS,
    );
    gapi.load("picker", {
      callback: () => finish(resolve),
      onerror: () =>
        finish(() => reject(new Error("google_picker_load_failed"))),
      timeout: PICKER_LOAD_TIMEOUT_MS,
      ontimeout: () =>
        finish(() => reject(new Error("google_picker_load_timeout"))),
    });
  });
}

/**
 * Open the Google Picker for the given session and resolve with the selected
 * Drive file ids. A user cancel resolves with `[]`. A failure to load the
 * script or the picker module rejects (never hangs), so the caller can show the
 * generic picker error.
 */
export async function openGoogleDrivePicker(
  session: GoogleDrivePickerSessionInput,
): Promise<string[]> {
  await loadGoogleApiScript();
  await loadPickerModule();

  const picker = getGooglePicker();
  if (!picker) {
    throw new Error("google_picker_unavailable");
  }

  return new Promise<string[]>((resolve, reject) => {
    try {
      const view = new picker.DocsView()
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setMimeTypes(session.mimeTypes.join(","));

      const built = new picker.PickerBuilder()
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .enableFeature(picker.Feature.SUPPORT_DRIVES)
        .setAppId(session.appId)
        .setOAuthToken(session.accessToken)
        .setDeveloperKey(session.developerKey)
        .setOrigin(window.location.origin)
        .addView(view)
        .setCallback((data) => {
          const action = data[picker.Response.ACTION];
          if (action === picker.Action.PICKED) {
            const documents = data[picker.Response.DOCUMENTS];
            const ids = Array.isArray(documents)
              ? documents
                  .map((doc) => {
                    const id = (doc as Record<string, unknown>)[
                      picker.Document.ID
                    ];
                    return typeof id === "string" ? id : "";
                  })
                  .filter((id) => id.length > 0)
              : [];
            resolve(ids);
          } else if (action === picker.Action.CANCEL) {
            resolve([]);
          }
        })
        .build();

      built.setVisible(true);
    } catch (error: unknown) {
      reject(
        error instanceof Error ? error : new Error("google_picker_failed"),
      );
    }
  });
}

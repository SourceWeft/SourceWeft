type BackgroundResult<T = unknown> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };

function sendCommand<T>(command: string) {
  return new Promise<BackgroundResult<T>>((resolve) => {
    chrome.runtime.sendMessage(
      { command },
      (response: BackgroundResult<T> | undefined) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message || "Runtime error",
          });
          return;
        }

        resolve(
          response || { ok: false, error: "No response from background" },
        );
      },
    );
  });
}

type SessionPayload = {
  authenticated: boolean;
  tokens: {
    expiresAt: number;
  } | null;
};

const root = document.getElementById("app");

if (!root) {
  throw new Error("Popup root element not found");
}

root.innerHTML = `
  <div style="font-family: Inter, system-ui, -apple-system, sans-serif; width: 320px; padding: 14px; color: #0f172a;">
    <h1 style="margin: 0 0 10px; font-size: 16px;">VelaMind Extension</h1>
    <p id="status" style="margin: 0 0 10px; font-size: 12px; color: #475569;">Checking session...</p>
    <p id="userinfo" style="margin: 0 0 10px; font-size: 12px; color: #334155;"></p>
    <div style="display: grid; gap: 8px;">
      <button id="login" style="padding: 8px 10px; border-radius: 8px; border: 1px solid #0f172a; background: #0f172a; color: white; font-size: 12px; cursor: pointer;">Sign in (PKCE)</button>
      <button id="refresh" style="padding: 8px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 12px; cursor: pointer;">Refresh token</button>
      <button id="userinfo-btn" style="padding: 8px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 12px; cursor: pointer;">Load user info</button>
      <button id="logout" style="padding: 8px 10px; border-radius: 8px; border: 1px solid #ef4444; background: #fff5f5; color: #b91c1c; font-size: 12px; cursor: pointer;">Sign out</button>
    </div>
  </div>
`;

const statusElement = document.getElementById("status") as HTMLParagraphElement;
const userInfoElement = document.getElementById(
  "userinfo",
) as HTMLParagraphElement;

function setStatus(
  value: string,
  tone: "default" | "error" | "success" = "default",
) {
  statusElement.textContent = value;
  if (tone === "error") {
    statusElement.style.color = "#b91c1c";
    return;
  }

  if (tone === "success") {
    statusElement.style.color = "#047857";
    return;
  }

  statusElement.style.color = "#475569";
}

function setUserInfo(value: string) {
  userInfoElement.textContent = value;
}

async function refreshSessionStatus() {
  const result = await sendCommand<SessionPayload>("auth.session");
  if (!result.ok) {
    setStatus(result.error, "error");
    return;
  }

  if (!result.data.authenticated) {
    setStatus("Not signed in", "default");
    return;
  }

  const expiresAt = result.data.tokens?.expiresAt
    ? new Date(result.data.tokens.expiresAt).toLocaleTimeString()
    : "unknown";
  setStatus(`Signed in. Token expires at ${expiresAt}`, "success");
}

async function runCommand(command: string, successMessage: string) {
  setStatus("Running...", "default");
  const result = await sendCommand(command);
  if (!result.ok) {
    setStatus(result.error, "error");
    return;
  }

  setStatus(successMessage, "success");
  await refreshSessionStatus();
}

document.getElementById("login")?.addEventListener("click", () => {
  void runCommand("auth.sign-in", "Sign-in successful");
});

document.getElementById("refresh")?.addEventListener("click", () => {
  void runCommand("auth.refresh", "Token refreshed");
});

document.getElementById("userinfo-btn")?.addEventListener("click", () => {
  void (async () => {
    const result = await sendCommand<Record<string, unknown>>("auth.userinfo");
    if (!result.ok) {
      setStatus(result.error, "error");
      return;
    }

    setStatus("User info loaded", "success");
    setUserInfo(JSON.stringify(result.data));
  })();
});

document.getElementById("logout")?.addEventListener("click", () => {
  void runCommand("auth.sign-out", "Signed out");
  setUserInfo("");
});

void refreshSessionStatus();

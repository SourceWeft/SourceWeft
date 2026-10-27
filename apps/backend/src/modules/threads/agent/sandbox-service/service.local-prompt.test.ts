import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  device: null as null | Record<string, string | null>,
  loadedFor: [] as string[],
}));

vi.mock("../../../devices/provider", () => ({
  localProviderForTurn: async () => ({ id: "local" }),
  boundDeviceEnvironment: async (threadId: string) => {
    state.loadedFor.push(threadId);
    return state.device;
  },
}));
vi.mock("./stores", () => ({
  DrizzleSandboxStore: class {},
  DrizzleSandboxOperationStore: class {},
}));
vi.mock("@sourceweft/builtin-tool-sandbox", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sourceweft/builtin-tool-sandbox")>();
  class FakeService {
    async createRuntimeForTurn() {
      return { buildRuntimePrompt: () => "BASE" };
    }
  }
  return { ...actual, AgentSandboxService: FakeService };
});

import { agentSandboxService } from "./service";

const BASE_TEXT =
  "Commands execute on the user's bound PC inside its authorized working folder. In user-facing updates and answers, describe this as running a command on the computer or in the working folder. Do not call it a cloud sandbox. Mention implementation terms such as sandbox/provider only if the user asks about implementation. Internal tool names do not change this execution location. Do not assume cloud-image packages are installed on this PC.";

const NETWORK_BLOCK =
  "<local_network_access>\nOutbound network access from commands on this PC may need the user's approval. A command that reaches a new host can pause until the user answers in the conversation. If a request is denied, the tool output explains why: do not retry the same host, and tell the user which host you needed and why. Connections to local, private and cloud-metadata addresses are always blocked.\n</local_network_access>";

const SECRETS_BLOCK =
  "<local_secrets>\nSome environment variables in commands on this PC may hold placeholder values that start with fake_value_. They are not the real secret: the real value is substituted only on requests to the hosts the user bound to that secret, so use the variable exactly as you would the real credential (for example in an Authorization header). Never print, store or send the variable's content anywhere else, and never put it in a request body unless you were asked to; a request whose body contains it always needs the user's approval. Requests to those hosts that change data (anything but GET, HEAD or OPTIONS) also ask the user first.\n</local_secrets>";

const request = {
  filesystem: {},
  executionTarget: { kind: "local" },
  context: { threadId: "thread-1" },
} as never;

async function prompt() {
  const runtime = await agentSandboxService.createRuntimeForTurn(request);
  return runtime!.buildRuntimePrompt();
}

describe("local execution prompt", () => {
  beforeEach(() => {
    state.device = null;
    state.loadedFor = [];
  });

  test("an old host leaves the presentation text byte-for-byte unchanged", async () => {
    state.device = {
      platform: null,
      arch: null,
      shell: null,
      sandboxState: null,
    };
    expect(await prompt()).toBe(
      `BASE\n<local_execution_presentation>\n${BASE_TEXT}\n</local_execution_presentation>\n${NETWORK_BLOCK}\n${SECRETS_BLOCK}`,
    );
    expect(state.loadedFor).toEqual(["thread-1"]);
  });

  test("a missing device row also leaves the text unchanged", async () => {
    expect(await prompt()).toBe(
      `BASE\n<local_execution_presentation>\n${BASE_TEXT}\n</local_execution_presentation>\n${NETWORK_BLOCK}\n${SECRETS_BLOCK}`,
    );
  });

  test("a Linux host appends its factual lines inside the block", async () => {
    state.device = {
      platform: "linux",
      arch: "arm64",
      shell: "bash",
      sandboxState: "ready",
    };
    const text = await prompt();
    expect(
      text.startsWith(
        `BASE\n<local_execution_presentation>\n${BASE_TEXT}\nOperating system: Linux (arm64)\n`,
      ),
    ).toBe(true);
    expect(text).toContain("Shell: bash (commands run under this shell)");
    expect(
      text.endsWith(
        `\n</local_execution_presentation>\n${NETWORK_BLOCK}\n${SECRETS_BLOCK}`,
      ),
    ).toBe(true);
  });
});

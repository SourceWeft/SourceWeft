import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertCollectSandboxPath,
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertPrepareSandboxPath,
  assertSandboxReadPath,
  assertSandboxWritePath,
  assertSourceWorkPath,
} from "../../src/runtime/paths";
import type { SandboxProviderPathPolicy } from "../../src/runtime/types";

const policy: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
};

test("sandbox path validation accepts only explicit SourceWeft and sandbox paths", () => {
  assert.equal(
    assertSourceWorkPath("/workfiles/novel/chapter-01.md"),
    "/workfiles/novel/chapter-01.md",
  );
  assert.equal(
    assertPrepareSandboxPath("/workspace/input/chapter-01.md", policy),
    "/workspace/input/chapter-01.md",
  );
  assert.equal(
    assertPrepareSandboxPath("/workspace/ppt-deck/script.py", policy),
    "/workspace/ppt-deck/script.py",
  );
  assert.equal(
    assertCollectSandboxPath("/workspace/output/report.md", policy),
    "/workspace/output/report.md",
  );
  assert.equal(
    assertSourceWorkPath("/workfiles/reports/report.md"),
    "/workfiles/reports/report.md",
  );
  assert.equal(assertExecuteCwd(undefined, policy), "/workspace");
  assert.equal(
    assertExecuteCwd("/workspace/ppt-deck", policy),
    "/workspace/ppt-deck",
  );
  assert.equal(
    assertSandboxWritePath("/workspace/ppt-deck/deck.js", policy),
    "/workspace/ppt-deck/deck.js",
  );
});

test("sandbox bridge path validation rejects kb, skills, traversal, and host paths", () => {
  assert.throws(
    () => assertSourceWorkPath("/kb/source.md"),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertSourceWorkPath("/skills/x/SKILL.md"),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertSourceWorkPath("/workfiles/../secret"),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertSourceWorkPath("/work/report.md"),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertPrepareSandboxPath("/tmp/file", policy),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertCollectSandboxPath("/tmp/sourceweft/file", policy),
    /SANDBOX_COLLECT_PATH_DENIED/,
  );
  assert.throws(
    () => assertExecuteCwd("/etc", policy),
    /SANDBOX_EXECUTE_CWD_DENIED/,
  );
  assert.throws(
    () => assertSandboxReadPath("/workfiles/file.md", policy),
    /SANDBOX_READ_PATH_DENIED/,
  );
  assert.throws(
    () => assertSandboxReadPath("/kb/source.md", policy),
    /SANDBOX_READ_PATH_DENIED/,
  );
  assert.throws(
    () => assertSandboxReadPath("/skills/ppt-deck/SKILL.md", policy),
    /SourceWeft DB-backed VFS logical path/,
  );
  assert.throws(
    () => assertSandboxReadPath("/tmp/sourceweft/status.json", policy),
    /SANDBOX_READ_PATH_DENIED/,
  );
  assert.throws(
    () => assertSandboxReadPath("/tmp/file", policy),
    /SANDBOX_READ_PATH_DENIED/,
  );
  assert.throws(
    () => assertSandboxWritePath("/skills/ppt-deck/SKILL.md", policy),
    /SANDBOX_READ_PATH_DENIED/,
  );
});

test("sandbox path validation is driven by provider policy", () => {
  const customPolicy: SandboxProviderPathPolicy = {
    workspaceRoot: "/task",
    defaultCwd: "/task",
    prepareTargetRoots: ["/task/input"],
    collectSourceRoots: ["/task/results"],
    readWriteRoots: ["/task", "/cache"],
  };

  assert.equal(
    assertPrepareSandboxPath("/task/input/deck.js", customPolicy),
    "/task/input/deck.js",
  );
  assert.equal(assertExecuteCwd(undefined, customPolicy), "/task");
  assert.equal(
    assertSandboxReadPath("/cache/status.json", customPolicy),
    "/cache/status.json",
  );
  assert.throws(
    () => assertPrepareSandboxPath("/workspace/input/deck.js", customPolicy),
    /SANDBOX_PREPARE_PATH_DENIED/,
  );
  assert.throws(
    () => assertSandboxReadPath("/workspace/ppt-deck/deck.js", customPolicy),
    /SANDBOX_READ_PATH_DENIED/,
  );
});

describe("assertExecuteCommandPathPolicy", () => {
  test("rejects SourceWeft VFS paths in execute commands", () => {
    assert.equal(
      assertExecuteCommandPathPolicy("python /work/foo.py"),
      "python /work/foo.py",
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("mkdir -p /workfiles/ppt-deck"),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("ls /kb"),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    assert.throws(
      () =>
        assertExecuteCommandPathPolicy(
          "set -e\ncat /workfiles/ppt-deck/deck.js\npwd",
        ),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("node /skills/tool-a/scripts/run.js"),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("printf '/workfiles literal only'"),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
  });

  test("does not reject host-looking absolute paths before provider execution", () => {
    assert.equal(
      assertExecuteCommandPathPolicy("cat /etc/passwd"),
      "cat /etc/passwd",
    );
    assert.equal(assertExecuteCommandPathPolicy("ls /root"), "ls /root");
    assert.equal(
      assertExecuteCommandPathPolicy('cat "/home/user/.env"'),
      'cat "/home/user/.env"',
    );
  });

  test("rejects empty commands and unsafe control characters but leaves shell path syntax to the provider", () => {
    assert.throws(
      () => assertExecuteCommandPathPolicy("  "),
      /SANDBOX_EXECUTE_COMMAND_DENIED: command is empty/,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("cat good\u0000bad"),
      /SANDBOX_EXECUTE_COMMAND_DENIED/,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy("cat good\u000bbad"),
      /SANDBOX_EXECUTE_COMMAND_DENIED/,
    );
    assert.equal(
      assertExecuteCommandPathPolicy("set -e\npwd\necho ok"),
      "set -e\npwd\necho ok",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("set -e\r\npwd\r\necho ok"),
      "set -e\r\npwd\r\necho ok",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("printf 'x\t%s' value"),
      "printf 'x\t%s' value",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("cat /workspace/../etc/passwd"),
      "cat /workspace/../etc/passwd",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("cat /workspace/~secret"),
      "cat /workspace/~secret",
    );
  });

  test("allows shell commands without interpreting command path strings", () => {
    assert.equal(assertExecuteCommandPathPolicy("npm test"), "npm test");
    assert.equal(
      assertExecuteCommandPathPolicy("node scripts/run.js"),
      "node scripts/run.js",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("curl https://example.com/file.txt"),
      "curl https://example.com/file.txt",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("python /workspace/ppt-deck/foo.py"),
      "python /workspace/ppt-deck/foo.py",
    );
    assert.equal(
      assertExecuteCommandPathPolicy("ls /tmp/sourceweft"),
      "ls /tmp/sourceweft",
    );
  });
});

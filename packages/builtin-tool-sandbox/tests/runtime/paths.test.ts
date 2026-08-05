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
  commandReferencesSkillsRoot,
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

  test("allows /skills in execute commands only when skill scripts are staged", () => {
    // Staged: /skills references the platform-staged bundle copies
    // (docs/architecture/sandbox-skill-staging.md D2).
    assert.equal(
      assertExecuteCommandPathPolicy(
        'python3 "/skills/ppt-deck/scripts/validate_pptx.py" deck.pptx',
        { skillScriptsStaged: true },
      ),
      'python3 "/skills/ppt-deck/scripts/validate_pptx.py" deck.pptx',
    );
    // The always-denied roots stay denied regardless of staging.
    assert.throws(
      () =>
        assertExecuteCommandPathPolicy("cat /workfiles/notes.md", {
          skillScriptsStaged: true,
        }),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    assert.throws(
      () =>
        assertExecuteCommandPathPolicy("ls /kb", { skillScriptsStaged: true }),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
    // Not staged (default): today's behavior, byte-identical.
    assert.throws(
      () =>
        assertExecuteCommandPathPolicy(
          'python3 "/skills/ppt-deck/scripts/validate_pptx.py" deck.pptx',
          { skillScriptsStaged: false },
        ),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
  });

  test("accepts the ppt-deck SKILL.md QA phase verbatim once staged", () => {
    // Acceptance baseline (docs/architecture/sandbox-skill-staging.md): the
    // exact command shape that produced SANDBOX_EXECUTE_VFS_PATH_DENIED in
    // the incident passes unchanged when skill scripts are staged.
    const qaPhase = [
      "set -e",
      'PPTX_ARTIFACT_PATH="/workspace/Claude_Introduction.pptx"',
      'QA_DIR="/workspace/qa"',
      'VALIDATE_PPTX="/skills/ppt-deck/scripts/validate_pptx.py"',
      'mkdir -p "$QA_DIR"',
      'echo "===CONTENT_QA==="',
      'python3 -m markitdown "$PPTX_ARTIFACT_PATH" > "$QA_DIR/content.txt"',
      'echo "===FILE_QA==="',
      'python3 "$VALIDATE_PPTX" "$PPTX_ARTIFACT_PATH"',
    ].join("\n");
    assert.equal(
      assertExecuteCommandPathPolicy(qaPhase, { skillScriptsStaged: true }),
      qaPhase,
    );
    assert.throws(
      () => assertExecuteCommandPathPolicy(qaPhase),
      /SANDBOX_EXECUTE_VFS_PATH_DENIED/,
    );
  });

  test("commandReferencesSkillsRoot flags the two-phase deferral signal", () => {
    assert.equal(
      commandReferencesSkillsRoot("python3 /skills/x/scripts/run.py"),
      true,
    );
    assert.equal(commandReferencesSkillsRoot('echo "/skills"'), true);
    assert.equal(commandReferencesSkillsRoot("ls /workspace"), false);
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

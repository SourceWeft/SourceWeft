import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  assertCollectSandboxPath,
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertPrepareSandboxPath,
  assertSourceWorkPath,
} from "./paths";

test("sandbox path validation accepts only explicit SourceWeft and sandbox paths", () => {
  assert.equal(assertSourceWorkPath("/work/novel/chapter-01.md"), "/work/novel/chapter-01.md");
  assert.equal(assertPrepareSandboxPath("/workspace/input/chapter-01.md"), "/workspace/input/chapter-01.md");
  assert.equal(assertPrepareSandboxPath("/workspace/work/script.py"), "/workspace/work/script.py");
  assert.equal(assertCollectSandboxPath("/workspace/output/report.md"), "/workspace/output/report.md");
  assert.equal(assertSourceWorkPath("/work/reports/report.md"), "/work/reports/report.md");
  assert.equal(assertExecuteCwd(undefined), "/workspace");
  assert.equal(assertExecuteCwd("/workspace/work"), "/workspace/work");
});

test("sandbox bridge path validation rejects kb, skills, traversal, and host paths", () => {
  assert.throws(() => assertSourceWorkPath("/kb/source.md"), /SANDBOX_PREPARE_PATH_DENIED/);
  assert.throws(() => assertSourceWorkPath("/skills/x/SKILL.md"), /SANDBOX_PREPARE_PATH_DENIED/);
  assert.throws(() => assertSourceWorkPath("/work/../secret"), /SANDBOX_PREPARE_PATH_DENIED/);
  assert.throws(() => assertPrepareSandboxPath("/tmp/file"), /SANDBOX_PREPARE_PATH_DENIED/);
  assert.throws(() => assertCollectSandboxPath("/workspace/input/file"), /SANDBOX_COLLECT_PATH_DENIED/);
  assert.throws(() => assertExecuteCwd("/etc"), /SANDBOX_EXECUTE_CWD_DENIED/);
});

describe("assertExecuteCommandPathPolicy", () => {
  test("rejects direct SourceWeft virtual filesystem paths", () => {
    expect(() => assertExecuteCommandPathPolicy("python /work/foo.py")).toThrow(
      "SANDBOX_EXECUTE_PATH_DENIED",
    );
    expect(() => assertExecuteCommandPathPolicy("cat '/kb/source.txt'")).toThrow(
      "SANDBOX_EXECUTE_PATH_DENIED",
    );
  });

  test("rejects absolute paths outside the allowed sandbox roots", () => {
    expect(() => assertExecuteCommandPathPolicy("cat /etc/passwd")).toThrow(
      "outside allowed sandbox roots",
    );
    expect(() => assertExecuteCommandPathPolicy("ls /root")).toThrow(
      "outside allowed sandbox roots",
    );
    expect(() => assertExecuteCommandPathPolicy("cat \"/home/user/.env\"")).toThrow(
      "outside allowed sandbox roots",
    );
  });

  test("rejects traversal and home expansion in absolute command paths", () => {
    expect(() => assertExecuteCommandPathPolicy("cat /workspace/../etc/passwd"))
      .toThrow("contains traversal or home directory expansion");
    expect(() => assertExecuteCommandPathPolicy("cat /workspace/~secret"))
      .toThrow("contains traversal or home directory expansion");
  });

  test("allows sandbox workspace, skills, and temp paths", () => {
    expect(assertExecuteCommandPathPolicy("npm test")).toBe("npm test");
    expect(assertExecuteCommandPathPolicy("node scripts/run.js")).toBe(
      "node scripts/run.js",
    );
    expect(assertExecuteCommandPathPolicy("curl https://example.com/file.txt"))
      .toBe("curl https://example.com/file.txt");
    expect(
      assertExecuteCommandPathPolicy("python /workspace/work/foo.py"),
    ).toBe("python /workspace/work/foo.py");
    expect(
      assertExecuteCommandPathPolicy("node /skills/tool-a/scripts/run.js"),
    ).toBe("node /skills/tool-a/scripts/run.js");
    expect(assertExecuteCommandPathPolicy("ls /tmp/sourceweft"))
      .toBe("ls /tmp/sourceweft");
  });

  test("uses caller supplied root policy instead of hardcoded roots", () => {
    expect(() =>
      assertExecuteCommandPathPolicy("cat /custom/foo.txt", {
        disallowedVirtualRoots: ["/custom"],
        allowedSandboxRoots: ["/sandbox"],
      }),
    ).toThrow("Use sandbox paths under /sandbox");
  });
});

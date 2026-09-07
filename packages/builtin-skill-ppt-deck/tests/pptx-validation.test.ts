import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("PPTX file QA checks actual page bounds, nested groups and rotation", () => {
  execFileSync(
    "python3",
    ["-B", fileURLToPath(new URL("./test_validate_pptx.py", import.meta.url))],
    { stdio: "pipe" },
  );
});

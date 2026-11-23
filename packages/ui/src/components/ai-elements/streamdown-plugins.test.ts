import { describe, expect, test } from "vitest";

import { pluginsNeededBy } from "./streamdown-plugins";

describe("pluginsNeededBy", () => {
  test("plain prose needs none of the heavy plugins", () => {
    expect(
      pluginsNeededBy("Hello **world**, inline `code` and a $5 price."),
    ).toEqual([]);
  });

  test("a fenced code block needs the code plugin", () => {
    expect(pluginsNeededBy("Run:\n\n```bash\nls\n```")).toEqual(["code"]);
    expect(pluginsNeededBy("~~~\nplain\n~~~")).toEqual(["code"]);
    expect(pluginsNeededBy("   ```ts\nconst a = 1\n```")).toEqual(["code"]);
  });

  test("an indented fence is a code block's text, not a fence", () => {
    expect(pluginsNeededBy("    ```\n    not a fence")).toEqual([]);
  });

  test("double-dollar math needs the math plugin", () => {
    expect(pluginsNeededBy("Energy: $$E = mc^2$$")).toEqual(["math"]);
  });

  test("a mermaid fence needs the code and mermaid plugins", () => {
    expect(pluginsNeededBy("```mermaid\ngraph TD; A-->B\n```")).toEqual([
      "code",
      "mermaid",
    ]);
  });

  test("a fence still streaming in counts", () => {
    expect(pluginsNeededBy("Here:\n```py")).toEqual(["code"]);
  });
});

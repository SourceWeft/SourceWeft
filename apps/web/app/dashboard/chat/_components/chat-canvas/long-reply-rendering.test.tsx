// @vitest-environment jsdom
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { Streamdown } from "streamdown";

test.each([false, true])(
  "long streaming markdown settles without nested update errors (animated=%s)",
  async (animated) => {
    const host = document.createElement("div");
    document.body.append(host);
    const errors: unknown[] = [];
    const root = createRoot(host, {
      onUncaughtError: (error) => errors.push(error),
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        errors.push(args);
      });
    // Real scheduler: act() drains every frame to quiescence and hides the
    // effect/setState cascade that occurs while network deltas keep arriving.
    const globals = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = false;
    const paragraph =
      "The report keeps earlier findings and adds the next verified result. ".repeat(
        6,
      );
    const markdown =
      Array.from({ length: 60 }, (_, i) => `## Step ${i}\n\n${paragraph}`).join(
        "\n\n",
      ) + "\n\nSTREAM_RENDER_DONE";
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      for (let end = 24; end < markdown.length; end += 24) {
        root.render(
          <Streamdown animated={animated} isAnimating>
            {markdown.slice(0, end)}
          </Streamdown>,
        );
        await tick();
        if (errors.length) break;
      }
      root.render(
        <Streamdown animated={animated} isAnimating={false}>
          {markdown}
        </Streamdown>,
      );
      const deadline = Date.now() + 5_000;
      while (
        !host.textContent?.includes("STREAM_RENDER_DONE") &&
        Date.now() < deadline &&
        !errors.length
      ) {
        await tick();
      }
      assert.deepEqual(errors, []);
      assert.ok(host.textContent?.includes("Step 0"));
      assert.ok(host.textContent?.endsWith("STREAM_RENDER_DONE"));
    } finally {
      root.unmount();
      host.remove();
      errorSpy.mockRestore();
      if (previousActEnvironment === undefined)
        delete globals.IS_REACT_ACT_ENVIRONMENT;
      else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
  60_000,
);

// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MindmapViewer,
  StudyHostProvider,
  type StudyHost,
} from "@sourceweft/builtin-tool-study/ui";
import {
  createRecordingStudyHost,
  mindmapFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import { button, flush, mount, unmountAll } from "@/test/react";

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

beforeAll(() => {
  // React Flow measures its viewport; jsdom has no layout engine.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function setMobile(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

async function renderMap(host: StudyHost) {
  await mount(
    createElement(
      StudyHostProvider,
      { host },
      createElement(MindmapViewer, { content: mindmapFixtureEn, version }),
    ),
  );
  await flush(3);
}

function outlineItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>("[role=treeitem]")].find(
    (node) =>
      node.querySelector("[data-node-label]")?.textContent?.trim() === label,
  );
}

function press(target: HTMLElement | undefined) {
  if (!target) throw new Error("missing control");
  return act(async () => target.click());
}

describe("MindmapViewer", () => {
  it("renders the map with every visible node on desktop", async () => {
    setMobile(false);
    await renderMap(createRecordingStudyHost());
    const map = document.querySelector("[data-study-mindmap-canvas]");
    expect(map).not.toBeNull();
    expect(map?.textContent).toContain("Photosynthesis");
    expect(map?.textContent).toContain("Stored as starch");
  });

  it("selects and folds nodes on the map", async () => {
    setMobile(false);
    await renderMap(createRecordingStudyHost());
    const canvasNode = (label: string) =>
      [...document.querySelectorAll<HTMLElement>("[data-mindmap-node]")].find(
        (node) =>
          node.querySelector("[data-node-label]")?.textContent?.trim() === label,
      );

    await press(canvasNode("Inputs")!.querySelector<HTMLElement>("[data-node-label]")!);
    expect(
      document.querySelector("[data-node-detail]")?.textContent,
    ).toContain("What the plant takes in.");

    await press(canvasNode("Outputs")!.querySelector<HTMLElement>("[data-node-toggle]")!);
    await flush(2);
    expect(canvasNode("Glucose")).toBeUndefined();
    // Folding did not change the selection.
    expect(
      document.querySelector("[data-node-detail] h3")?.textContent,
    ).toBe("Inputs");
  });

  it("switches to the outline view, folds and unfolds a branch", async () => {
    setMobile(false);
    await renderMap(createRecordingStudyHost());
    await press(button("study.mindmap.view.outline"));
    expect(document.querySelector("[role=tree]")).not.toBeNull();
    expect(outlineItem("Glucose")).toBeDefined();

    const outputs = outlineItem("Outputs")!;
    expect(outputs.getAttribute("aria-expanded")).toBe("true");
    await press(
      outputs.querySelector<HTMLElement>("[data-node-toggle]") ?? undefined,
    );
    expect(outlineItem("Glucose")).toBeUndefined();
    expect(outlineItem("Outputs")!.getAttribute("aria-expanded")).toBe("false");

    await press(
      outlineItem("Outputs")!.querySelector<HTMLElement>("[data-node-toggle]") ??
        undefined,
    );
    expect(outlineItem("Glucose")).toBeDefined();
  });

  it("shows a node's summary and evidence, and asks in chat without sending", async () => {
    setMobile(false);
    const host = createRecordingStudyHost();
    await renderMap(host);
    await press(button("study.mindmap.view.outline"));
    await press(
      outlineItem("Inputs")!.querySelector<HTMLElement>("[data-node-label]") ??
        undefined,
    );
    const detail = document.querySelector<HTMLElement>("[data-node-detail]")!;
    expect(detail.textContent).toContain("What the plant takes in.");
    await press(button("study.evidence.show", detail));
    expect(detail.textContent).toContain(
      "Plants take in water, carbon dioxide and light.",
    );

    await press(button("study.mindmap.askInChat", detail));
    const asks = host.callsTo("askInChat") as Array<{
      text: string;
      evidence?: unknown[];
    }>;
    expect(asks).toHaveLength(1);
    expect(asks[0]!.text).toContain("Inputs");
    expect(asks[0]!.evidence).toEqual(
      mindmapFixtureEn.root.children[0]!.evidence,
    );
    // The host decides what asking means; the viewer only ever hands it over.
    expect(host.calls.map((call) => call.method)).not.toContain("sendMessage");
  });

  it("opens in the outline view on a phone, folded below the second level", async () => {
    setMobile(true);
    await renderMap(createRecordingStudyHost());
    expect(document.querySelector("[role=tree]")).not.toBeNull();
    expect(outlineItem("Glucose")).toBeDefined();
    expect(outlineItem("Stored as starch")).toBeUndefined();
    expect(outlineItem("Glucose")!.getAttribute("aria-expanded")).toBe("false");
    await press(button("study.mindmap.view.map"));
    expect(document.querySelector("[data-study-mindmap-canvas]")).not.toBeNull();
  });

  it("exports Markdown and JSON through the host", async () => {
    setMobile(false);
    const host = createRecordingStudyHost();
    await renderMap(host);
    await press(button("study.mindmap.exportMarkdown"));
    await press(button("study.mindmap.exportJson"));
    const downloads = host.callsTo("downloadText") as Array<{
      fileName: string;
      mimeType: string;
      body: string;
    }>;
    expect(downloads.map((d) => d.mimeType)).toEqual([
      "text/markdown",
      "application/json",
    ]);
    expect(downloads[0]!.fileName).toMatch(/\.md$/);
    expect(downloads[0]!.body.startsWith("# Photosynthesis")).toBe(true);
    expect(JSON.parse(downloads[1]!.body).root.id).toBe("n_root");
  });

  it("hides asking in chat when the viewer is not interactive", async () => {
    setMobile(true);
    await renderMap(createRecordingStudyHost({ interactive: false }));
    await press(
      outlineItem("Inputs")!.querySelector<HTMLElement>("[data-node-label]") ??
        undefined,
    );
    expect(button("study.mindmap.askInChat")).toBeUndefined();
  });
});

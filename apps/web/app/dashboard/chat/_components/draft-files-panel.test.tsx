// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
vi.mock("./chat-work-context", () => ({
  WorkingFolderPicker: () =>
    createElement("button", null, "Choose existing folder…"),
}));
vi.mock("./local-files-panel", () => ({
  LocalFilesBrowser: (props: {
    basePath: string;
    availability: { ready: boolean };
  }) =>
    createElement(
      "output",
      { "data-ready": props.availability.ready },
      props.basePath,
    ),
}));
import { DraftFilesPanel, type DraftWorkContext } from "./draft-files-panel";
const local: DraftWorkContext = {
  target: { kind: "local", deviceId: "pc" },
  nativeId: "pc",
  selectedDevice: {
    id: "pc",
    name: "My Mac",
    online: true,
    connected: true,
    remoteEnabled: false,
  },
  ready: true,
  error: null,
};
const render = (context: DraftWorkContext) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      <DraftFilesPanel context={context} onFolderChange={vi.fn()} />
    </NextIntlClientProvider>,
  );
test("unselected local draft explains lazy creation and offers a folder choice", () => {
  const html = render(local);
  expect(html).toContain("Conversation folder");
  expect(html).toContain("created automatically");
  expect(html).toContain("Choose existing folder");
  expect(html).not.toContain("<output");
});
test("selected local draft browses the authorized folder before a conversation exists", () => {
  const html = render({
    ...local,
    target: { kind: "local", deviceId: "pc", folderId: "grant" },
  });
  expect(html).toContain("/v1/local-devices/pc/folders/grant/files");
  expect(html).toContain('data-ready="true"');
  expect(html).not.toContain("created automatically");
});
test("offline draft preserves the selected folder and disables browsing", () => {
  const html = render({
    ...local,
    target: { kind: "local", deviceId: "pc", folderId: "grant" },
    selectedDevice: { ...local.selectedDevice!, online: false },
  });
  expect(html).toContain("selection is preserved");
  expect(html).toContain('data-ready="false"');
  expect(html).toContain("/grant/files");
});
test("cloud drafts do not offer local directory controls", () => {
  const html = render({ ...local, target: { kind: "cloud" } });
  expect(html).toContain("Conversation cloud files");
  expect(html).not.toContain("Choose existing folder");
  expect(html).not.toContain("<output");
});

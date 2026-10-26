// @vitest-environment jsdom
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_ARTIFACT_STORAGE_TEXT,
  type ArtifactStorageText,
} from "@sourceweft/contracts/artifact-storage-text";
import {
  ArtifactStorageBar,
  ExternalLinkPrompt,
  NavigatedAwayNotice,
  NavigationAttemptsNote,
} from "@sourceweft/builtin-tool-publish-artifact/ui/artifact-storage-ui";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import zhTW from "@/messages/zh-TW.json";
import { flush, mountWithIntl, unmountAll } from "@/test/react";
import { useArtifactStorageText } from "./use-artifact-storage-text";

afterEach(unmountAll);

type Catalog = { artifactShare: { storage: Record<string, string> } };

function Probe({ onText }: { onText: (text: ArtifactStorageText) => void }) {
  onText(useArtifactStorageText());
  return null;
}

async function textFor(locale: string, catalog: Catalog) {
  let seen: ArtifactStorageText | null = null;
  await mountWithIntl(
    <Probe
      onText={(text) => {
        seen = text;
      }}
    />,
    { locale, messages: catalog as never },
  );
  assert.ok(seen);
  return seen as ArtifactStorageText;
}

test("every prompt has a message in every locale and the package defaults match English", () => {
  const keys = Object.keys(DEFAULT_ARTIFACT_STORAGE_TEXT).sort();
  for (const catalog of [en, zhCN, zhTW] as Catalog[]) {
    assert.deepEqual(Object.keys(catalog.artifactShare.storage).sort(), keys);
  }
  assert.deepEqual(
    (en as Catalog).artifactShare.storage,
    DEFAULT_ARTIFACT_STORAGE_TEXT,
  );
});

test("the hook returns the viewer's language and the prompts render from it", async () => {
  const zh = await textFor("zh-CN", zhCN as Catalog);
  assert.equal(zh.linkTitle, "即将离开 SourceWeft");

  const link = renderToStaticMarkup(
    <ExternalLinkPrompt
      url={new URL("https://example.com/a")}
      onCancel={() => undefined}
      onContinue={() => undefined}
      text={zh}
    />,
  );
  assert.match(link, /即将离开 SourceWeft/);
  assert.match(link, /取消/);
  assert.doesNotMatch(link, /Leaving SourceWeft|Cancel|Continue/);

  const away = renderToStaticMarkup(
    <NavigatedAwayNotice onReload={() => undefined} text={zh} />,
  );
  assert.match(away, /重新加载页面/);

  assert.match(
    renderToStaticMarkup(<NavigationAttemptsNote count={3} text={zh} />),
    /最近试图离开页面 3 次/,
  );
});

test("the English plural forms and the text object stay stable across renders", async () => {
  const text = await textFor("en", en as Catalog);
  assert.match(
    renderToStaticMarkup(<NavigationAttemptsNote count={1} text={text} />),
    /page 1 time recently/,
  );
  assert.match(
    renderToStaticMarkup(<NavigationAttemptsNote count={2} text={text} />),
    /page 2 times recently/,
  );
});

test("the approval bar renders the translated sentence with its emphasis and filled names", async () => {
  const zh = await textFor("zh-CN", zhCN as Catalog);
  const person = { id: "u", name: "李雷" };
  const mounted = await mountWithIntl(
    <ArtifactStorageBar
      shared
      text={zh}
      transport={
        {
          status: async () => ({
            storage: true,
            shared: true,
            author: person,
            approval: null,
            consented: false,
            canApprove: true,
            navigationAttempts: 2,
          }),
        } as never
      }
    />,
    { locale: "zh-CN", messages: zhCN as never },
  );
  await flush();
  const root = mounted.container;
  assert.match(root.textContent ?? "", /等待你的审批/);
  assert.equal(root.querySelector("strong")?.textContent, "共享数据");
  assert.match(root.textContent ?? "", /最近试图离开页面 2 次/);
  assert.doesNotMatch(root.textContent ?? "", /<strong>|Waiting for/);
});

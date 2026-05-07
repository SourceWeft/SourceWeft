import assert from "node:assert/strict";
import test from "node:test";
import { chunkSourceContent } from "./chunker";
import { DEFAULT_CHUNK_SIZE } from "./sources/parsing-config";

test("chunkSourceContent filters whitespace-only chunks", async () => {
  const content = `${"\n\t  ".repeat(40)}Receipt / Invoice\n\n${" \n".repeat(40)}Order details`;
  const chunks = await chunkSourceContent(content, {
    chunkSize: 20,
  });

  assert.equal(chunks.some((chunk) => chunk.text.trim().length === 0), false);
  assert.equal(
    chunks.every((chunk) => content.trim().slice(chunk.startIndex, chunk.endIndex) === chunk.text),
    true,
  );
});

test("chunkSourceContent uses langchain recursive defaults with configured overlap", async () => {
  const content = [
    "## SSL Certificates",
    "",
    "If you purchased an SSL certificate, the installation should be complete within 10 minutes. If you have a new domain, it may take up to 48 hours.",
    "",
    "## Hosting",
    "",
    "If you purchased hosting, now you can unbox your activated plan. Unboxing is a way to connect your products in a few simple stages. When it's finished, visit Hosting Manager to access your hosting account.",
    "",
    "## Renewals",
    "",
    "To avoid your subscriptions from expiring, we recommend you turn on auto-renew. We offer a variety of payment options for auto-renewals.",
    "",
    "84-2675481",
    "",
    "Phoenix, AZ 85034, US.",
    "",
    "Spaceship is a trademark and/or registered trademark of Spaceship, Inc.A",
    "",
    "<!-- Meanless: Feel free to contact our Customer Service team if you have any<br>questions or concerns. They're available 24/7.<br>support@spaceship.com -->",
  ].join("\n");

  const chunks = await chunkSourceContent(content, {
    chunkSize: 512,
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.startIndex, 0);
  assert.equal(chunks[1]?.startIndex, 387);
  assert.equal(chunks[1]?.text.startsWith("## Renewals"), true);

  for (const chunk of chunks) {
    assert.equal(content.trim().slice(chunk.startIndex, chunk.endIndex), chunk.text);
  }
});

test("chunkSourceContent keeps short trailing sections together with default size", async () => {
  const content = `${"正文".repeat(430)}\n\n备注\n\n开票人：邓光茹`;
  const chunks = await chunkSourceContent(content);

  assert.equal(DEFAULT_CHUNK_SIZE, 1000);
  assert.equal(chunks.some((chunk) => chunk.text.trim() === "备注"), false);
  assert.equal(
    chunks.some((chunk) => chunk.text.includes("备注\n\n开票人：邓光茹")),
    true,
  );
});

test("chunkSourceContent merges short invoice tail chunks into previous chunk", async () => {
  const invoiceLine =
    "¥50.00银行账号：512906888710101 购方开户银行：中国工商银行股份有限公司无锡滨湖支行； 销方开户银行：招商银行股份有限公司苏州分行营业部； 银行账号：110302119200826533； ";
  const content = `${invoiceLine.repeat(8)}备注\n\n开票人：邓光茹`;
  const chunks = await chunkSourceContent(content);
  const lastChunk = chunks.at(-1);

  assert.ok(lastChunk);
  assert.equal(lastChunk.text.trim() === "开票人：邓光茹", false);
  assert.equal(lastChunk.text.includes("备注\n\n开票人：邓光茹"), true);

  for (const chunk of chunks) {
    assert.equal(content.trim().slice(chunk.startIndex, chunk.endIndex), chunk.text);
  }
});

test("chunkSourceContent uses the HTML splitter for HTML-heavy content", async () => {
  const paragraph = "This is a paragraph inside a div. ".repeat(12);
  const content = [
    "<!DOCTYPE html>",
    "<html>",
    "<body>",
    "<div>",
    "<h1>Hello World</h1>",
    `<p>${paragraph}</p>`,
    "</div>",
    "<div>",
    "<h2>Section 2</h2>",
    `<p>${paragraph}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");

  const chunks = await chunkSourceContent(content, {
    chunkSize: 220,
  });

  assert.equal(chunks.length > 1, true);
  assert.equal(chunks[0]?.text.startsWith("<!DOCTYPE html>"), true);
  assert.equal(
    chunks.some((chunk) => chunk.text.startsWith("<div>\n<h2>Section 2</h2>")),
    true,
  );

  for (const chunk of chunks) {
    assert.equal(content.trim().slice(chunk.startIndex, chunk.endIndex), chunk.text);
  }
});

test("chunkSourceContent does not start HTML chunks inside tag attributes", async () => {
  const content = [
    "<table id=\"hnmain\"><tbody><tr id=\"bigbox\"><td><table><tbody>",
    "<tr class=\"athing submission\" id=\"48047826\"><td align=\"right\" valign=\"top\" class=\"title\"><span class=\"rank\">25.</span></td><td class=\"title\"><span class=\"titleline\"><a href=\"https://ahk.cardor.dev/\">Agent-harness-kit scaffolding for multi-agent workflows (MCP, provider-agnostic)</a><span class=\"sitebit comhead\"> (<a href=\"https://news.ycombinator.com/from?site=cardor.dev\"><span class=\"sitestr\">cardor.dev</span></a>)</span></span></td></tr>",
    "<tr><td colspan=\"2\"></td><td class=\"subtext\"><span class=\"subline\"><span class=\"score\" id=\"score_48047826\">61 points</span> by <a href=\"https://news.ycombinator.com/user?id=enmanuelmag\" class=\"hnuser\">enmanuelmag</a><span class=\"age\" title=\"2026-05-07T10:45:59 1778150759\"><a href=\"https://news.ycombinator.com/item?id=48047826\">7 hours ago</a></span> | <a href=\"https://news.ycombinator.com/hide?id=48047826&amp;goto=news\">hide</a> | <a href=\"https://news.ycombinator.com/item?id=48047826\">18&nbsp;comments</a></span></td></tr>",
    "<tr class=\"spacer\" style=\"height:5px\"></tr>",
    "<tr class=\"athing submission\" id=\"48045012\"><td align=\"right\" valign=\"top\" class=\"title\"><span class=\"rank\">26.</span></td><td class=\"title\"><span class=\"titleline\"><a href=\"https://aniket.foo/posts/20260505-netboot/\">Diskless Linux boot using ZFS, iSCSI and PXE</a><span class=\"sitebit comhead\"> (<a href=\"https://news.ycombinator.com/from?site=aniket.foo\"><span class=\"sitestr\">aniket.foo</span></a>)</span></span></td></tr>",
    "<tr><td colspan=\"2\"></td><td class=\"subtext\"><span class=\"subline\"><span class=\"score\" id=\"score_48045012\">174 points</span> by <a href=\"https://news.ycombinator.com/user?id=stereo-highway\" class=\"hnuser\">stereo-highway</a><span class=\"age\" title=\"2026-05-07T03:13:24 1778123604\"><a href=\"https://news.ycombinator.com/item?id=48045012\">15 hours ago</a></span> | <a href=\"https://news.ycombinator.com/hide?id=48045012&amp;goto=news\">hide</a> | <a href=\"https://news.ycombinator.com/item?id=48045012\">91&nbsp;comments</a></span></td></tr>",
    "</tbody></table></td></tr></tbody></table>",
  ].join("\n");

  const chunks = await chunkSourceContent(content, {
    chunkSize: 260,
  });

  assert.equal(
    chunks.some((chunk) => /^(align|valign|class|href|title)=/.test(chunk.text.trim())),
    false,
  );

  for (const chunk of chunks) {
    assert.equal(content.trim().slice(chunk.startIndex, chunk.endIndex), chunk.text);
  }
});

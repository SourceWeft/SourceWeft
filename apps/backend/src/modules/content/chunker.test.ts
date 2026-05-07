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

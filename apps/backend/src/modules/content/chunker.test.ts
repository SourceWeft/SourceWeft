import assert from "node:assert/strict";
import test from "node:test";
import { chunkSourceContent } from "./chunker";

test("chunkSourceContent filters whitespace-only chunks", async () => {
  const content = `${"\n\t  ".repeat(40)}Receipt / Invoice\n\n${" \n".repeat(40)}Order details`;
  const chunks = await chunkSourceContent(content, {
    chunkSize: 20,
  });

  assert.equal(chunks.some((chunk) => chunk.text.trim().length === 0), false);
  assert.equal(chunks.map((chunk) => chunk.text).join("").includes("Receipt / Invoice"), true);
  assert.equal(chunks.map((chunk) => chunk.text).join("").includes("Order details"), true);
});

test("chunkSourceContent keeps sentence starts with their following words", async () => {
  const content = `## SSL Certificates

If you purchased an SSL certificate, the installation should be complete within 10 minutes. If you have a new domain, it may take up to 48 hours.

## Hosting

If you purchased hosting, now you can unbox your activated plan. Unboxing is a way to connect your products in a few simple stages. When it's finished, visit Hosting Manager to access your hosting account.

## Renewals

To avoid your subscriptions from expiring, we recommend you turn on auto-renew. We offer a variety of payment options for auto-renewals.

84-2675481

Phoenix, AZ 85034, US.

Spaceship is a trademark and/or registered trademark of Spaceship, Inc.A

<!-- Meanless: Feel free to contact our Customer Service team if you have any<br>questions or concerns. They're available 24/7.<br>support@spaceship.com -->`;

  const chunks = await chunkSourceContent(content, {
    chunkSize: 512,
  });

  assert.equal(chunks.map((chunk) => chunk.text).join(""), content.trim());
  assert.equal(
    chunks.some((chunk) => /## Hosting\s+If$/.test(chunk.text)),
    false,
  );
  assert.equal(
    chunks.some((chunk) =>
      chunk.text.includes(
        "If you purchased hosting, now you can unbox your activated plan.",
      ),
    ),
    true,
  );

  for (const chunk of chunks) {
    assert.equal(content.trim().slice(chunk.startIndex, chunk.endIndex), chunk.text);
  }
});

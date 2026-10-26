import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { printable, terminalSafe } from "../src/mcp/oauth/redact";
import { readHiddenLine } from "../src/ui";

describe("server text on a terminal", () => {
  it("replaces controls, escape sequences and invisible format characters", () => {
    const hostile =
      "a\u001b]52;c;QUJD\u0007b\u001b[2Jc\u009bd\u200be\ufefff\u{E0041}g\uFE0Fh\u202ei\u2028j";
    const text = printable(hostile);
    // eslint-disable-next-line no-control-regex, no-misleading-character-class
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200b\ufeff\u{E0000}-\u{E007F}\uFE0F\u202e\u2028]/u.test(text), JSON.stringify(text));
    for (const word of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
      assert.ok(text.includes(word), word);
    }
  });

  it("keeps line breaks in a message but nothing else that acts", () => {
    const text = terminalSafe("one\u001b[31m\ntwo\u0007\n\u200bthree");
    assert.equal(text, "one [31m\ntwo \n three");
  });
});

describe("hidden line input", () => {
  function terminal() {
    const input = Object.assign(new PassThrough(), {
      raw: [] as boolean[],
      setRawMode(mode: boolean) {
        this.raw.push(mode);
        return this;
      },
    });
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk: Buffer) => {
      shown += chunk.toString("utf8");
    });
    return { input, output, shown: () => shown };
  }

  it("reads a line without echoing it, applies backspace and restores the terminal", async () => {
    const t = terminal();
    const pending = readHiddenLine(t.input, t.output, "Key: ");
    t.input.write("sk-12");
    t.input.write("3x\u007f4\r");
    assert.equal(await pending, "sk-1234");
    assert.deepEqual(t.input.raw, [true, false]);
    assert.ok(!t.shown().includes("sk-"));
    assert.ok(t.shown().startsWith("Key: "));
  });

  it("cancels on Ctrl-C", async () => {
    const t = terminal();
    const pending = readHiddenLine(t.input, t.output, "Key: ");
    t.input.write("abc\u0003");
    await assert.rejects(pending, /Cancelled/u);
    assert.deepEqual(t.input.raw, [true, false]);
  });
});

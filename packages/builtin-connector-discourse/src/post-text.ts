/** Longest post HTML the converter reads; the rest is ignored. */
const MAX_INPUT_CHARS = 1_000_000;
/** Blockquotes nested deeper than this are flattened into the last level. */
const MAX_QUOTE_DEPTH = 20;
/** List nesting beyond this is not indented any further. */
const MAX_LIST_INDENT = 5;
const MAX_ALT_CHARS = 200;
const MAX_ONEBOX_TITLE_CHARS = 500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Separated from their neighbours by a blank line. */
const PARAGRAPH_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "aside",
  "article",
  "section",
  "header",
  "footer",
  "figure",
  "figcaption",
  "details",
  "summary",
  "ul",
  "ol",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "hr",
]);

/** Content of these elements is raw text, never markup and never output. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** The whole subtree of these elements is dropped. */
const SKIPPED_SUBTREES = new Set([
  "svg",
  "noscript",
  "template",
  "iframe",
  "object",
]);

const RAW_TEXT_CLOSERS: Record<string, RegExp> = {
  script: /<\/script(?=[\s/>])/gi,
  style: /<\/style(?=[\s/>])/gi,
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z]{2,6});/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        const valid =
          Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          (code < 0xd800 || code > 0xdfff);
        return valid ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

const isLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number): boolean =>
  isLetter(code) || (code >= 48 && code <= 57);
const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 12;

/**
 * Index of the `>` that ends the tag whose text starts at `from`, skipping
 * quoted attribute values (a quote only opens a value right after `=`), or
 * -1. Costs one pass over the tag.
 */
function findTagEnd(source: string, from: number): number {
  const n = source.length;
  let previous = 0;
  let j = from;
  while (j < n) {
    const code = source.charCodeAt(j);
    if (code === 62) return j;
    if ((code === 34 || code === 39) && previous === 61) {
      const close = source.indexOf(code === 34 ? '"' : "'", j + 1);
      if (close === -1) return -1;
      j = close + 1;
      previous = 34;
      continue;
    }
    if (!isSpace(code)) previous = code;
    j += 1;
  }
  return -1;
}

/**
 * The values of the named attributes of a tag. `inner` is the text between
 * `<` and `>`, starting at the tag name. One pass, bounded by the tag size.
 */
function attributesOf(
  inner: string,
  nameEnd: number,
  wanted: string[],
): Map<string, string> {
  const found = new Map<string, string>();
  const n = inner.length;
  let j = nameEnd;
  while (j < n) {
    while (j < n && (isSpace(inner.charCodeAt(j)) || inner[j] === "/")) j += 1;
    const start = j;
    while (
      j < n &&
      !isSpace(inner.charCodeAt(j)) &&
      inner[j] !== "=" &&
      inner[j] !== "/"
    ) {
      j += 1;
    }
    const name = inner.slice(start, j).toLowerCase();
    if (j === start) {
      j += 1;
      continue;
    }
    while (j < n && isSpace(inner.charCodeAt(j))) j += 1;
    let value = "";
    if (inner[j] === "=") {
      j += 1;
      while (j < n && isSpace(inner.charCodeAt(j))) j += 1;
      const quote = inner[j];
      if (quote === '"' || quote === "'") {
        const close = inner.indexOf(quote, j + 1);
        const end = close === -1 ? n : close;
        value = inner.slice(j + 1, end);
        j = end + 1;
      } else {
        const valueStart = j;
        while (j < n && !isSpace(inner.charCodeAt(j))) j += 1;
        value = inner.slice(valueStart, j);
      }
    }
    if (wanted.includes(name) && !found.has(name)) found.set(name, value);
  }
  return found;
}

function hasClass(classes: string | undefined, token: string): boolean {
  return classes !== undefined && classes.split(/\s+/).includes(token);
}

/** Longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (let k = 0; k < text.length; k += 1) {
    if (text.charCodeAt(k) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

function normalise(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One level of output: the document, or the inside of a blockquote. */
type Frame = {
  out: string[];
  /** Newlines currently ending the output (2 at the start of a frame). */
  newlines: number;
  /** True right after a list marker, until its first text. */
  bullet: boolean;
};

const newFrame = (): Frame => ({ out: [], newlines: 2, bullet: false });

/**
 * Plain text of a Discourse post's `cooked` HTML. Block elements become line
 * breaks, `<li>` becomes `- `, `<pre>` a fenced block and `<code>` an inline
 * span, `<blockquote>` lines are prefixed `> `, an image becomes
 * `[image: alt]` (never its URL), a link keeps only its text, and a onebox is
 * reduced to its title. Scripts, styles, comments and SVG are dropped and
 * entities are decoded once. Input is capped at 1,000,000 characters. The
 * scan is linear and never throws, whatever the markup.
 */
export function postHtmlToText(html: string): string {
  if (typeof html !== "string") return "";
  const source = (
    html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html
  ).replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "");
  const n = source.length;

  const frames: Frame[] = [newFrame()];
  let extraQuotes = 0;
  let listDepth = 0;
  const top = (): Frame => frames[frames.length - 1] as Frame;

  // Raw capture of `<pre>` / inline `<code>`.
  let capture: { kind: "pre" | "code"; parts: string[] } | null = null;
  // Subtree being dropped.
  let skip: { tag: string; depth: number } | null = null;
  // `<aside class="onebox">` being reduced to its title.
  let onebox: {
    depth: number;
    collecting: boolean;
    done: boolean;
    title: string;
  } | null = null;

  const lineBreak = (blank: boolean): void => {
    const frame = top();
    if (frame.bullet) return;
    const need = blank ? 2 : 1;
    if (frame.newlines < need) {
      frame.out.push("\n".repeat(need - frame.newlines));
      frame.newlines = need;
    }
  };
  const hardBreak = (): void => {
    const frame = top();
    if (frame.bullet) return;
    frame.out.push("\n");
    frame.newlines += 1;
  };
  /** Appends an already formed inline string. */
  const push = (piece: string): void => {
    const frame = top();
    frame.out.push(frame.bullet ? ` ${piece}` : piece);
    frame.newlines = 0;
    frame.bullet = false;
  };
  const text = (raw: string): void => {
    const frame = top();
    let piece = decodeEntities(raw).replace(/\s+/g, " ");
    if (frame.newlines > 0 || frame.bullet) piece = piece.trimStart();
    if (piece === "") return;
    push(piece);
  };

  const closeQuote = (): void => {
    if (extraQuotes > 0) {
      extraQuotes -= 1;
      return;
    }
    if (frames.length <= 1) return;
    const frame = frames.pop() as Frame;
    const body = normalise(frame.out.join(""));
    if (body === "") return;
    lineBreak(true);
    push(
      body
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n"),
    );
    lineBreak(true);
  };

  const finishCapture = (): void => {
    if (capture === null) return;
    const { kind, parts } = capture;
    capture = null;
    const raw = parts
      .join("")
      .replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, "\n");
    if (kind === "pre") {
      const body = raw.replace(/^\n/, "").trimEnd();
      if (body === "") return;
      const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
      lineBreak(true);
      push(`${fence}\n${body}\n${fence}`);
      lineBreak(true);
    } else {
      const body = raw.replace(/\s+/g, " ").trim();
      if (body === "") return;
      const fence = "`".repeat(longestBacktickRun(body) + 1);
      const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
      push(`${fence}${pad}${body}${pad}${fence}`);
    }
  };

  const finishOnebox = (): void => {
    if (onebox === null) return;
    const title = onebox.title.replace(/\s+/g, " ").trim();
    onebox = null;
    if (title === "") return;
    lineBreak(true);
    push(title.slice(0, MAX_ONEBOX_TITLE_CHARS));
    lineBreak(true);
  };

  const handleText = (raw: string): void => {
    if (skip !== null) return;
    if (onebox !== null) {
      if (onebox.collecting) {
        onebox.title += decodeEntities(raw);
      }
      return;
    }
    if (capture !== null) {
      capture.parts.push(decodeEntities(raw));
      return;
    }
    text(raw);
  };

  let i = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      handleText(source.slice(i));
      break;
    }
    if (lt > i) handleText(source.slice(i, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const next = source.charCodeAt(lt + 1);
    if (next === 33 || next === 63) {
      // `<!DOCTYPE ...>`, `<![CDATA[...`, `<?xml ...?>`: markup noise.
      const gt = source.indexOf(">", lt + 2);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    const closing = next === 47;
    const nameStart = lt + (closing ? 2 : 1);
    if (!isLetter(source.charCodeAt(nameStart))) {
      // "<" that opens no tag (`a < b`): it is text.
      handleText("<");
      i = lt + 1;
      continue;
    }
    const gt = findTagEnd(source, nameStart);
    // An unterminated tag: what follows is markup noise, not content.
    if (gt === -1) break;
    i = gt + 1;
    let nameEnd = nameStart;
    while (nameEnd < gt && isNameChar(source.charCodeAt(nameEnd))) nameEnd += 1;
    const name = source.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = source.charCodeAt(gt - 1) === 47;

    if (!closing && RAW_TEXT_TAGS.has(name)) {
      if (!selfClosing) {
        const closer = RAW_TEXT_CLOSERS[name] as RegExp;
        closer.lastIndex = i;
        const found = closer.exec(source);
        if (!found) break;
        const closeEnd = source.indexOf(">", found.index);
        if (closeEnd === -1) break;
        i = closeEnd + 1;
      }
      continue;
    }

    if (skip !== null) {
      if (skip.tag === name && !VOID_TAGS.has(name) && !selfClosing) {
        skip.depth += closing ? -1 : 1;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }

    if (onebox !== null) {
      if (name === "aside" && !selfClosing) {
        onebox.depth += closing ? -1 : 1;
        if (onebox.depth === 0) finishOnebox();
      } else if (name === "h3" && !onebox.done) {
        if (!closing && !onebox.collecting) onebox.collecting = true;
        else if (closing && onebox.collecting) {
          onebox.collecting = false;
          onebox.done = true;
        }
      }
      continue;
    }

    if (capture !== null) {
      if (closing && name === capture.kind) finishCapture();
      else if (name === "br" && capture.kind === "pre")
        capture.parts.push("\n");
      continue;
    }

    if (closing) {
      if (name === "blockquote") {
        closeQuote();
      } else if (name === "li") {
        lineBreak(false);
      } else if (name === "ul" || name === "ol") {
        if (listDepth > 0) listDepth -= 1;
        lineBreak(listDepth === 0);
      } else if (name === "tr") {
        lineBreak(false);
      } else if (PARAGRAPH_TAGS.has(name) || name === "pre") {
        lineBreak(true);
      }
      continue;
    }

    // Opening (or self-closing) tags.
    if (SKIPPED_SUBTREES.has(name)) {
      if (!selfClosing) skip = { tag: name, depth: 1 };
      continue;
    }
    if (name === "div" || name === "aside") {
      const classes = attributesOf(
        source.slice(nameStart, gt),
        nameEnd - nameStart,
        ["class"],
      ).get("class");
      if (name === "div" && hasClass(classes, "meta") && !selfClosing) {
        skip = { tag: "div", depth: 1 };
        continue;
      }
      if (name === "aside" && hasClass(classes, "onebox") && !selfClosing) {
        onebox = { depth: 1, collecting: false, done: false, title: "" };
        continue;
      }
    }
    if (name === "img") {
      const alt = attributesOf(
        source.slice(nameStart, gt),
        nameEnd - nameStart,
        ["alt"],
      ).get("alt");
      if (alt === undefined) {
        push("[image]");
      } else {
        const label = decodeEntities(alt)
          .replace(/[\s[\]]+/g, " ")
          .trim()
          .slice(0, MAX_ALT_CHARS)
          .trim();
        if (label !== "") push(`[image: ${label}]`);
      }
      continue;
    }
    if (name === "pre") {
      lineBreak(true);
      capture = { kind: "pre", parts: [] };
      continue;
    }
    if (name === "code") {
      capture = { kind: "code", parts: [] };
      continue;
    }
    if (name === "br") {
      hardBreak();
    } else if (name === "blockquote") {
      if (frames.length < MAX_QUOTE_DEPTH) {
        lineBreak(true);
        frames.push(newFrame());
      } else {
        extraQuotes += 1;
        lineBreak(true);
      }
    } else if (name === "ul" || name === "ol") {
      lineBreak(listDepth === 0);
      listDepth += 1;
    } else if (name === "li") {
      lineBreak(false);
      const indent = "  ".repeat(
        Math.min(Math.max(listDepth - 1, 0), MAX_LIST_INDENT),
      );
      const frame = top();
      frame.out.push(`${indent}-`);
      frame.newlines = 0;
      frame.bullet = true;
    } else if (name === "tr") {
      lineBreak(false);
    } else if (name === "td" || name === "th") {
      if (top().newlines === 0) push(" | ");
    } else if (PARAGRAPH_TAGS.has(name)) {
      lineBreak(true);
    }
  }

  // Whatever is still open at the end of the input is closed.
  finishOnebox();
  finishCapture();
  while (frames.length > 1) closeQuote();
  return normalise(frames[0]?.out.join("") ?? "");
}

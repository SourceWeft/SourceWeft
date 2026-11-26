/** Longest HTML the converter reads; the rest is ignored. */
const MAX_INPUT_CHARS = 2_000_000;
/** Attribute values longer than this are ignored. */
const MAX_ATTRIBUTE_CHARS = 2_000;
/** Default cut of the returned Markdown. */
const DEFAULT_MAX_CHARS = 500_000;
/** Blockquotes nested deeper than this are flattened into the last level. */
const MAX_QUOTE_DEPTH = 20;
/** List nesting beyond this is not indented any further. */
const MAX_LIST_INDENT = 5;

export type HtmlToMarkdownOptions = {
  /** Output is cut at a line boundary at or below this many characters. */
  maxChars?: number;
};

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
  "section",
  "article",
  "figure",
  "figcaption",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "address",
  "details",
  "summary",
  "caption",
  "dl",
  "dt",
  "dd",
]);

/** Content of these elements is raw text, never markup and never output. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** The whole subtree of these elements is dropped. */
const SKIPPED_SUBTREES = new Set([
  "svg",
  "iframe",
  "form",
  "noscript",
  "template",
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

/** Tags that end an inline `<code>` capture that was never closed. */
const CODE_TERMINATORS = new Set([
  ...PARAGRAPH_TAGS,
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "blockquote",
  "pre",
  "hr",
]);

/** C0 controls except tab and newline, plus DEL. */
const CONTROL_IN_CODE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
const CONTROL_IN_HREF = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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
 * Values longer than the attribute ceiling are ignored.
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
        const tooLong = end - j - 1 > MAX_ATTRIBUTE_CHARS;
        value = tooLong ? "" : inner.slice(j + 1, end);
        j = end + 1;
        if (tooLong) continue;
      } else {
        const valueStart = j;
        while (j < n && !isSpace(inner.charCodeAt(j))) j += 1;
        if (j - valueStart > MAX_ATTRIBUTE_CHARS) continue;
        value = inner.slice(valueStart, j);
      }
    }
    if (wanted.includes(name) && !found.has(name)) found.set(name, value);
  }
  return found;
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

/** A link target worth keeping: http(s), no control characters. */
function safeUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  const decoded = decodeEntities(value);
  if (CONTROL_IN_HREF.test(decoded)) return null;
  if (!/^https?:\/\/[^\s/?#]/i.test(decoded)) return null;
  return decoded.replace(/[\s()<>]/g, (c) =>
    c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
  );
}

/** One level of output: the document, or the inside of a blockquote. */
type Frame = {
  out: string[];
  /** Newlines currently ending the output (2 at the start of a frame). */
  newlines: number;
  /** A list or heading marker waiting for the first text of its line. */
  pending: string | null;
};

const newFrame = (): Frame => ({ out: [], newlines: 2, pending: null });

const lastPiece = (frame: Frame): string =>
  frame.out.length === 0 ? "" : (frame.out[frame.out.length - 1] as string);

const finalize = (parts: string[]): string =>
  parts
    .join("")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();

/** Cuts `text` at `maxChars` on a line boundary. */
function cutAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (text.charCodeAt(maxChars) === 10)
    return text.slice(0, maxChars).trimEnd();
  const head = text.slice(0, maxChars);
  const boundary = head.lastIndexOf("\n");
  // A single line longer than the limit has no boundary to cut at.
  return (boundary === -1 ? head : head.slice(0, boundary)).trimEnd();
}

/**
 * Markdown for a fragment of HTML (a WordPress post body, a feed entry). One
 * left-to-right scan with an explicit stack; no DOM, nothing executed.
 * Headings, paragraphs, lists, blockquotes, code, tables, links and emphasis
 * are kept; an image becomes its alt text (never its URL); a link is kept
 * only for an http(s) target without control characters. Scripts, styles,
 * SVG, iframes, forms, comments, CDATA and doctypes are dropped with their
 * content, and entities are decoded once. Input is capped at 2,000,000
 * characters, attribute values at 2,000, and the scan is linear and never
 * throws, whatever the markup. An unterminated tag at the end of the input is
 * dropped, as is an unterminated comment.
 */
export function htmlToMarkdown(
  html: string,
  options: HtmlToMarkdownOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!(maxChars > 0)) {
    throw new RangeError("maxChars must be a positive number");
  }
  const source =
    html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html;
  const n = source.length;

  const frames: Frame[] = [newFrame()];
  let extraQuotes = 0;
  const lists: {
    ordered: boolean;
    count: number;
    level: number;
    /** Spaces before this list's markers. */
    indent: number;
  }[] = [];
  const top = (): Frame => frames[frames.length - 1] as Frame;

  // Emphasis markers opened but not yet written (written with the next text).
  const emph: string[] = [];
  const emphOpen = { "**": 0, "*": 0 };

  // Raw capture of `<pre>` / inline `<code>`.
  let capture = null as { kind: "pre" | "code"; parts: string[] } | null;
  // Subtree being dropped.
  let skip: { tag: string; depth: number } | null = null;
  // Link being collected.
  let link: {
    frame: Frame;
    index: number;
    url: string;
    prefix: string;
    newlines: number;
    pending: string | null;
  } | null = null;
  // Table row being collected, and the table nesting around it.
  let tableDepth = 0;
  let row: {
    frame: Frame;
    extra: number;
    cells: string[];
    cellStart: number | null;
    newlines: number;
  } | null = null;

  const trimTrailingSpace = (frame: Frame): void => {
    if (frame.newlines === 0 && frame.out.length > 0) {
      const last = lastPiece(frame);
      if (last.endsWith(" ")) {
        frame.out[frame.out.length - 1] = last.replace(/ +$/, "");
      }
    }
  };
  const lineBreak = (blank: boolean): void => {
    const frame = top();
    if (frame.pending !== null) return;
    const need = blank ? 2 : 1;
    if (frame.newlines < need) {
      trimTrailingSpace(frame);
      const add = "\n".repeat(need - frame.newlines);
      if (frame.newlines > 0 && frame.out.length > 0) {
        frame.out[frame.out.length - 1] += add;
      } else {
        frame.out.push(add);
      }
      frame.newlines = need;
    }
  };
  /** A blank line between blocks, a single newline inside a list. */
  const blockBreak = (): void => lineBreak(lists.length === 0);
  const hardBreak = (): void => {
    const frame = top();
    if (frame.pending !== null || frame.newlines >= 2) return;
    trimTrailingSpace(frame);
    if (frame.newlines > 0 && frame.out.length > 0) {
      frame.out[frame.out.length - 1] += "\n";
    } else {
      frame.out.push("\n");
    }
    frame.newlines += 1;
  };
  /** Appends an already formed inline string. */
  const push = (piece: string): void => {
    const frame = top();
    let s = piece;
    if (emph.length > 0) {
      s = emph.join("") + s;
      emph.length = 0;
    }
    if (frame.pending !== null) {
      s = `${frame.pending} ${s}`;
      frame.pending = null;
    }
    frame.out.push(s);
    frame.newlines = 0;
  };
  const text = (raw: string): void => {
    const frame = top();
    let piece = decodeEntities(raw)
      .replace(CONTROL_IN_TEXT, "")
      .replace(/\s+/g, " ");
    const atStart =
      frame.newlines > 0 ||
      frame.pending !== null ||
      lastPiece(frame).endsWith(" ");
    if (atStart) piece = piece.trimStart();
    if (piece === "") return;
    if (emph.length > 0 && piece.startsWith(" ")) {
      // The space goes before the opening marker: `a ** b**` is not bold.
      frame.out.push(" ");
      piece = piece.slice(1);
      if (piece === "") return;
    }
    push(piece);
  };

  const openEmphasis = (marker: "**" | "*"): void => {
    emphOpen[marker] += 1;
    emph.push(marker);
  };
  const closeEmphasis = (marker: "**" | "*"): void => {
    if (emphOpen[marker] === 0) return;
    emphOpen[marker] -= 1;
    if (emph[emph.length - 1] === marker) {
      // Nothing was written inside it.
      emph.pop();
      return;
    }
    const frame = top();
    if (frame.pending !== null) return;
    // The closing marker goes before trailing whitespace.
    let tail = "";
    if (frame.newlines > 0 && frame.out.length > 0) {
      tail = frame.out.pop() as string;
    }
    const last = lastPiece(frame);
    if (last.endsWith(" ")) {
      frame.out[frame.out.length - 1] = last.slice(0, -1);
      tail = ` ${tail}`;
    }
    frame.out.push(marker);
    if (tail !== "") frame.out.push(tail);
  };

  const cellTextOf = (frame: Frame, start: number): string =>
    frame.out
      .splice(start)
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\|/g, "\\|");

  /** Closes blockquotes opened inside the row's current cell. */
  const unwindToRow = (): void => {
    if (row === null) return;
    if (top() !== row.frame) {
      extraQuotes = 0;
      while (top() !== row.frame && frames.length > 1) closeQuote();
    }
    extraQuotes = row.extra;
  };
  const finishCell = (): void => {
    if (row === null || row.cellStart === null) return;
    unwindToRow();
    row.cells.push(cellTextOf(row.frame, row.cellStart));
    row.cellStart = null;
    row.frame.newlines = row.newlines;
    row.frame.pending = null;
    emph.length = 0;
  };
  const finishRow = (): void => {
    if (row === null) return;
    finishCell();
    const done = row;
    row = null;
    if (done.cells.every((cell) => cell === "")) return;
    done.frame.out.push(`| ${done.cells.join(" | ")} |`);
    done.frame.newlines = 0;
  };
  const startRow = (): void => {
    finishRow();
    lineBreak(false);
    row = {
      frame: top(),
      extra: extraQuotes,
      cells: [],
      cellStart: null,
      newlines: top().newlines,
    };
  };
  const startCell = (): void => {
    if (row === null) return;
    finishCell();
    unwindToRow();
    row.newlines = row.frame.newlines;
    row.frame.pending = null;
    row.cellStart = row.frame.out.length;
    row.frame.newlines = 2;
  };

  const finishLink = (): void => {
    if (link === null) return;
    const done = link;
    link = null;
    const frame = done.frame;
    if (top() !== frame) return;
    const pieces = frame.out.splice(done.index);
    let label = pieces.join("");
    if (label.startsWith(done.prefix)) label = label.slice(done.prefix.length);
    const trimmed = label.trim();
    if (trimmed === "") {
      frame.newlines = done.newlines;
      frame.pending = done.pending;
      return;
    }
    const lead = label.slice(0, label.length - label.trimStart().length);
    const trail = label.slice(label.trimEnd().length);
    const body = trimmed.includes("\n") ? trimmed : `[${trimmed}](${done.url})`;
    frame.out.push(`${done.prefix}${lead}${body}${trail}`);
    frame.newlines = trail.endsWith("\n\n") ? 2 : trail.endsWith("\n") ? 1 : 0;
  };

  function closeQuote(): void {
    if (extraQuotes > 0) {
      extraQuotes -= 1;
      return;
    }
    if (frames.length <= 1) return;
    if (link !== null && link.frame === top()) link = null;
    if (row !== null && row.frame === top()) finishRow();
    const frame = frames.pop() as Frame;
    const body = finalize(frame.out);
    if (body === "") return;
    blockBreak();
    push(
      body
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n"),
    );
    blockBreak();
  }

  const finishCapture = (): void => {
    if (capture === null) return;
    const { kind, parts } = capture;
    capture = null;
    const raw = parts
      .join("")
      .replace(CONTROL_IN_CODE, "")
      .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n");
    if (kind === "pre") {
      const body = raw.replace(/^\n/, "").trimEnd();
      if (body === "") return;
      const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
      blockBreak();
      push(`${fence}\n${body}\n${fence}`);
      blockBreak();
    } else {
      const body = raw.replace(/\s+/g, " ").trim();
      if (body === "") return;
      const fence = "`".repeat(longestBacktickRun(body) + 1);
      const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
      push(`${fence}${pad}${body}${pad}${fence}`);
    }
  };

  const handleText = (raw: string): void => {
    if (skip !== null) return;
    if (capture !== null) {
      capture.parts.push(decodeEntities(raw));
      return;
    }
    if (row !== null && row.cellStart === null) {
      if (raw.trim() === "") return;
      startCell();
    }
    text(raw);
  };

  const closingTag = (name: string): void => {
    if (name === "a") {
      finishLink();
    } else if (name === "strong" || name === "b") {
      closeEmphasis("**");
    } else if (name === "em" || name === "i") {
      closeEmphasis("*");
    } else if (name === "blockquote") {
      closeQuote();
    } else if (name === "li") {
      top().pending = null;
      lineBreak(false);
    } else if (name === "ul" || name === "ol") {
      if (lists.length > 0) lists.pop();
      lineBreak(lists.length === 0);
    } else if (name === "table") {
      if (tableDepth === 1) finishRow();
      if (tableDepth > 0) tableDepth -= 1;
      blockBreak();
    } else if (tableDepth === 1 && name === "tr") {
      finishRow();
    } else if (tableDepth === 1 && (name === "td" || name === "th")) {
      finishCell();
    } else if (/^h[1-6]$/.test(name)) {
      top().pending = null;
      blockBreak();
    } else if (PARAGRAPH_TAGS.has(name) || name === "pre") {
      blockBreak();
    }
  };

  const openingTag = (
    name: string,
    nameStart: number,
    nameEnd: number,
    gt: number,
  ): void => {
    const attrs = (wanted: string[]): Map<string, string> =>
      attributesOf(source.slice(nameStart, gt), nameEnd - nameStart, wanted);

    if (name === "a") {
      finishLink();
      const url = safeUrl(attrs(["href"]).get("href"));
      if (url !== null) {
        const frame = top();
        link = {
          frame,
          index: frame.out.length,
          url,
          prefix:
            (frame.pending !== null ? `${frame.pending} ` : "") + emph.join(""),
          newlines: frame.newlines,
          pending: frame.pending,
        };
      }
    } else if (name === "img") {
      const alt = attrs(["alt"]).get("alt");
      if (alt !== undefined) handleText(alt);
    } else if (name === "strong" || name === "b") {
      openEmphasis("**");
    } else if (name === "em" || name === "i") {
      openEmphasis("*");
    } else if (name === "br") {
      hardBreak();
    } else if (name === "hr") {
      blockBreak();
      push("---");
      blockBreak();
    } else if (name === "pre") {
      blockBreak();
      capture = { kind: "pre", parts: [] };
    } else if (name === "code") {
      capture = { kind: "code", parts: [] };
    } else if (name === "blockquote") {
      blockBreak();
      if (frames.length - 1 < MAX_QUOTE_DEPTH) frames.push(newFrame());
      else extraQuotes += 1;
    } else if (name === "ul" || name === "ol") {
      lineBreak(lists.length === 0);
      const parent = lists[lists.length - 1];
      const level = parent ? parent.level + 1 : 0;
      // Nested items line up with the text of their parent's marker.
      const indent =
        parent && level <= MAX_LIST_INDENT
          ? parent.indent + (parent.ordered ? 3 : 2)
          : (parent?.indent ?? 0);
      lists.push({ ordered: name === "ol", count: 0, level, indent });
    } else if (name === "li") {
      const frame = top();
      frame.pending = null;
      lineBreak(false);
      const list = lists[lists.length - 1];
      if (list) list.count += 1;
      const marker = list?.ordered ? `${list.count}.` : "-";
      frame.pending = `${" ".repeat(list?.indent ?? 0)}${marker}`;
    } else if (/^h[1-6]$/.test(name)) {
      blockBreak();
      top().pending = "#".repeat(Number(name[1]));
    } else if (name === "table") {
      if (tableDepth === 0) finishRow();
      tableDepth += 1;
      blockBreak();
    } else if (tableDepth === 1 && name === "tr") {
      startRow();
    } else if (tableDepth === 1 && (name === "td" || name === "th")) {
      if (row === null) startRow();
      startCell();
    } else if (PARAGRAPH_TAGS.has(name)) {
      blockBreak();
    }
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
      const end = source.indexOf("-->", lt + 2);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const next = source.charCodeAt(lt + 1);
    if (next === 33 || next === 63) {
      // `<!DOCTYPE ...>`, `<?xml ...?>`: markup noise.
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
    // An unterminated tag at the end of the input is dropped.
    if (gt === -1) break;
    i = gt + 1;
    let nameEnd = nameStart;
    while (nameEnd < gt && isNameChar(source.charCodeAt(nameEnd))) nameEnd += 1;
    const name = source.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = source.charCodeAt(gt - 1) === 47;

    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const closer = RAW_TEXT_CLOSERS[name] as RegExp;
      closer.lastIndex = i;
      const found = closer.exec(source);
      if (!found) break;
      const closeEnd = source.indexOf(">", found.index);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      continue;
    }

    if (skip !== null) {
      if (skip.tag === name && !VOID_TAGS.has(name)) {
        skip.depth += closing ? -1 : 1;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }
    if (!closing && SKIPPED_SUBTREES.has(name)) {
      if (!(name === "svg" && selfClosing)) skip = { tag: name, depth: 1 };
      continue;
    }

    if (capture !== null) {
      if (closing && name === capture.kind) {
        finishCapture();
      } else if (capture.kind === "pre") {
        if (name === "br") capture.parts.push("\n");
      } else if (CODE_TERMINATORS.has(name)) {
        // An inline `<code>` that was never closed ends at the next block.
        finishCapture();
        if (closing) closingTag(name);
        else openingTag(name, nameStart, nameEnd, gt);
      }
      continue;
    }

    if (closing) closingTag(name);
    else openingTag(name, nameStart, nameEnd, gt);
  }

  // Whatever is still open at the end of the input is closed.
  finishCapture();
  finishLink();
  finishRow();
  while (frames.length > 1) closeQuote();
  extraQuotes = 0;
  return cutAtLine(finalize(frames[0]?.out ?? []), maxChars);
}

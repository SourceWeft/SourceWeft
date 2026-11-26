import assert from "node:assert/strict";
import test from "node:test";
import { postHtmlToText } from "../src/post-text";

test("paragraphs and headings become separate blocks", () => {
  assert.equal(
    postHtmlToText("<h2>Title</h2><p>First</p><p>Second</p>"),
    "Title\n\nFirst\n\nSecond",
  );
});

test("br is a single line break and inline tags keep their text", () => {
  assert.equal(postHtmlToText("a<br>b<br/>c"), "a\nb\nc");
  assert.equal(
    postHtmlToText("<p>a <strong>b <em>c</em></strong> d</p>"),
    "a b c d",
  );
});

test("list items get a dash and their own line, nested items are indented", () => {
  assert.equal(
    postHtmlToText("<ul><li>one</li><li>two<ul><li>inner</li></ul></li></ul>"),
    "- one\n- two\n  - inner",
  );
  assert.equal(postHtmlToText("<ul><li><p>loose</p></li></ul>"), "- loose");
});

test("blockquote lines are prefixed, nested quotes stack", () => {
  assert.equal(
    postHtmlToText(
      "<p>before</p><blockquote><p>q1</p><p>q2</p></blockquote><p>after</p>",
    ),
    "before\n\n> q1\n>\n> q2\n\nafter",
  );
  assert.equal(
    postHtmlToText("<blockquote>a<blockquote>b</blockquote></blockquote>"),
    "> a\n>\n> > b",
  );
});

test("discourse quote asides keep the quoted text", () => {
  const html =
    '<aside class="quote no-group" data-username="bob"><div class="title"><img alt="" src="https://x.test/a.png" class="avatar"> bob:</div><blockquote><p>quoted</p></blockquote></aside><p>reply</p>';
  assert.equal(postHtmlToText(html), "bob:\n\n> quoted\n\nreply");
});

test("pre blocks are fenced and keep whitespace", () => {
  assert.equal(
    postHtmlToText(
      '<pre><code class="lang-js">let a = 1;\n  if (a &lt; 2) {}\n</code></pre>',
    ),
    "```\nlet a = 1;\n  if (a < 2) {}\n```",
  );
});

test("a fence grows past any backtick run inside the code", () => {
  const text = postHtmlToText("<pre><code>a ``` b</code></pre>");
  assert.equal(text, "````\na ``` b\n````");
});

test("inline code stays inline", () => {
  assert.equal(
    postHtmlToText("<p>use <code>npm i</code> now</p>"),
    "use `npm i` now",
  );
  assert.equal(postHtmlToText("<p><code>a`b</code></p>"), "``a`b``");
});

test("images keep only their alt text and never a URL", () => {
  const text = postHtmlToText(
    '<p><img src="https://evil.test/p.png" alt="a diagram"> and <img src="https://evil.test/q.png"></p>',
  );
  assert.equal(text, "[image: a diagram] and [image]");
  assert.ok(!text.includes("evil.test"));
  assert.equal(postHtmlToText('<img src="x" alt="">'), "");
  assert.equal(
    postHtmlToText('<img alt="line1\nline2 [x]">'),
    "[image: line1 line2 x]",
  );
});

test("links keep only their text", () => {
  const text = postHtmlToText(
    '<p>see <a href="https://evil.test/x?y=1">the docs</a> or <a href="https://evil.test/">https://evil.test/</a></p>',
  );
  assert.equal(text, "see the docs or https://evil.test/");
  assert.ok(!text.includes("?y=1"));
});

test("mentions and hashtags are text", () => {
  assert.equal(
    postHtmlToText(
      '<p><a class="mention" href="/u/bob">@bob</a> <a class="hashtag" href="/c/x">#<span>general</span></a></p>',
    ),
    "@bob #general",
  );
});

test("onebox keeps only the title text", () => {
  const html =
    '<p>look</p><aside class="onebox allowlistedgeneric" data-onebox-src="https://evil.test/p"><header class="source"><a href="https://evil.test/p"><img src="https://evil.test/i.png" class="site-icon">evil.test</a></header><article class="onebox-body"><h3><a href="https://evil.test/p">The Page Title</a></h3><p>A long description.</p></article></aside><p>after</p>';
  const text = postHtmlToText(html);
  assert.equal(text, "look\n\nThe Page Title\n\nafter");
  assert.ok(!text.includes("evil.test"));
  assert.ok(!text.includes("description"));
});

test("onebox without a title yields nothing, nested asides do not end it early", () => {
  assert.equal(
    postHtmlToText(
      '<aside class="onebox"><aside class="x"><h3>Inner</h3></aside><p>dropped</p></aside><p>kept</p>',
    ),
    "Inner\n\nkept",
  );
  assert.equal(
    postHtmlToText('<aside class="onebox"><header>h</header></aside>kept'),
    "kept",
  );
});

test("script, style, svg and comments are dropped", () => {
  assert.equal(
    postHtmlToText(
      "<p>a</p><script>var x = '<p>evil</p>';</script><style>p{color:red}</style><!-- hidden --><svg><title>t</title><use href='#x'/></svg><p>b</p>",
    ),
    "a\n\nb",
  );
  assert.equal(postHtmlToText("a<SCRIPT >x</SCRIPT >b"), "ab");
});

test("lightbox meta is dropped", () => {
  assert.equal(
    postHtmlToText(
      '<div class="lightbox-wrapper"><a class="lightbox" href="x"><img src="x" alt="shot"><div class="meta"><span class="filename">shot.png</span><span>1x1 2 KB</span></div></a></div>',
    ),
    "[image: shot]",
  );
});

test("table cells are separated and rows break lines", () => {
  assert.equal(
    postHtmlToText(
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ),
    "a | b\n1 | 2",
  );
});

test("entities are decoded exactly once", () => {
  assert.equal(
    postHtmlToText("<p>a &amp; b &lt;i&gt; &quot;q&quot; it&#39;s&nbsp;ok</p>"),
    `a & b <i> "q" it's ok`,
  );
  assert.equal(postHtmlToText("&amp;lt;"), "&lt;");
  assert.equal(postHtmlToText("&#65;&#x42;"), "AB");
  assert.equal(
    postHtmlToText("&#0; &#1114112; &#xD800; &bogus;"),
    "&#0; &#1114112; &#xD800; &bogus;",
  );
});

test("encoded markup is text, not a tag", () => {
  assert.equal(
    postHtmlToText("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "<script>alert(1)</script>",
  );
});

test("attributes may contain a greater-than sign", () => {
  assert.equal(
    postHtmlToText('<p><img alt="a > b" src="x"> t</p>'),
    "[image: a > b] t",
  );
});

test("control characters are removed and unusual newlines normalised", () => {
  assert.equal(postHtmlToText("a\u0000b\u0007c"), "abc");
  assert.equal(postHtmlToText("<pre>a\r\nb\u2028c</pre>"), "```\na\nb\nc\n```");
});

test("truncated and broken input never throws", () => {
  const cases = [
    "",
    "<",
    "<p",
    '<p attr="',
    "<!--",
    "<!-- x",
    "<script>",
    "<style>x",
    "<pre><code>unclosed",
    "<blockquote>open",
    "<aside class='onebox'><h3>t",
    "</p></li></blockquote></pre></aside>",
    "a < b > c",
    "<<<<>>>>",
    "<![CDATA[x]]>",
    "<?xml version='1.0'?>",
  ];
  for (const html of cases) {
    assert.equal(typeof postHtmlToText(html), "string");
  }
  assert.equal(postHtmlToText("<pre><code>unclosed"), "```\nunclosed\n```");
  assert.equal(postHtmlToText("<blockquote>open"), "> open");
  assert.equal(postHtmlToText("a < b > c"), "a < b > c");
  assert.equal(postHtmlToText(null as unknown as string), "");
});

test("deeply nested blockquotes and lists stay bounded", () => {
  const html =
    "<blockquote>".repeat(5_000) + "x" + "</blockquote>".repeat(5_000);
  const text = postHtmlToText(html);
  assert.ok(text.includes("x"));
  assert.ok(text.length < 10_000);
  const lists = "<ul><li>".repeat(5_000) + "y";
  assert.ok(postHtmlToText(lists).length < 100_000);
});

test("the input is capped at 1,000,000 characters", () => {
  const html = "a".repeat(1_000_000) + "<p>TAIL</p>";
  const text = postHtmlToText(html);
  assert.ok(!text.includes("TAIL"));
  assert.equal(text.length, 1_000_000);
});

const ADVERSARIAL: Array<[string, string]> = [
  ["tag-open runs", "<a ".repeat(333_333)],
  ["tag-open runs closed once", "<a ".repeat(333_000) + ">"],
  ["quote runs in a tag", '<a x="'.repeat(166_000)],
  ["comment-open runs", "<!--".repeat(250_000)],
  ["comment-open runs closed", "<!-- ".repeat(100_000) + "-->"],
  ["numeric entity floods", "&#".repeat(500_000)],
  ["hex entity floods", "&#x".repeat(333_000)],
  ["ampersand floods", "&".repeat(1_000_000)],
  ["named entity floods", "&amp".repeat(200_000)],
  ["stray angle brackets", "< ".repeat(500_000)],
  ["empty paragraphs", "<p></p>".repeat(140_000)],
  ["list items", "<li>".repeat(250_000)],
  ["script opens", "<script>".repeat(125_000)],
  ["script bodies", "<script>x</script>".repeat(55_000)],
  ["pre opens", "<pre>".repeat(200_000)],
  ["br runs", "<br>".repeat(250_000)],
  ["onebox opens", "<aside class=onebox>".repeat(50_000)],
  ["svg opens", "<svg>".repeat(200_000)],
  ["blockquote churn", "<blockquote>x</blockquote>".repeat(40_000)],
  ["backtick code", "<pre>" + "`".repeat(990_000) + "</pre>"],
  ["attribute floods", "<img " + 'a="b" '.repeat(160_000) + ">"],
  ["end tags", "</p>".repeat(250_000)],
];

for (const [name, html] of ADVERSARIAL) {
  test(`adversarial ${name} finishes quickly`, () => {
    const started = performance.now();
    const text = postHtmlToText(html);
    const elapsed = performance.now() - started;
    assert.equal(typeof text, "string");
    assert.ok(elapsed < 1_000, `${name} took ${Math.round(elapsed)} ms`);
  });
}

test("random markup soup never throws and never leaks a URL", () => {
  const pieces = [
    "<",
    ">",
    "</",
    "/>",
    "<p>",
    "</p>",
    "<a href='https://leak.test/'>",
    "</a>",
    "<pre>",
    "</pre>",
    "<code>",
    "</code>",
    "<blockquote>",
    "</blockquote>",
    "<aside class='onebox'>",
    "</aside>",
    "<h3>",
    "</h3>",
    "<li>",
    "<ul>",
    "</ul>",
    "<img src='https://leak.test/i.png' alt='x'>",
    "<script>",
    "</script>",
    "<!--",
    "-->",
    "&amp;",
    "&#",
    "&#x",
    ";",
    '"',
    "'",
    "=",
    " ",
    "\n",
    "text",
    "<svg>",
    "</svg>",
    "<div class='meta'>",
    "</div>",
    "<table>",
    "<td>",
    "<tr>",
  ];
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 500; round += 1) {
    let html = "";
    const length = next() % 60;
    for (let k = 0; k < length; k += 1) {
      html += pieces[next() % pieces.length];
    }
    const text = postHtmlToText(html);
    assert.equal(typeof text, "string");
    assert.ok(!text.includes("leak.test"), html);
  }
});

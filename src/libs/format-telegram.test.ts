import assert from "node:assert/strict";
import test from "node:test";
import { formatForTelegramHtml } from "./format-telegram.js";

test("formats supported Markdown while escaping raw HTML", () => {
  assert.equal(
    formatForTelegramHtml("# Title\n**bold** *italic* ~~gone~~ <script>"),
    "<b>Title</b>\n<b>bold</b> <i>italic</i> <s>gone</s> &lt;script&gt;",
  );
});

test("protects code from Markdown conversion and escapes code HTML", () => {
  assert.equal(formatForTelegramHtml("`**x** <b>`"), "<code>**x** &lt;b&gt;</code>");
  assert.equal(
    formatForTelegramHtml("```ts\nconst x = '<tag>';\n```"),
    "<pre><code>const x = '&lt;tag&gt;';</code></pre>",
  );
});

test("converts inline and block LaTeX to Telegram-safe Unicode", () => {
  assert.equal(
    formatForTelegramHtml("$x_2 + \\alpha^2 \\leq \\frac{1}{2}$"),
    "<code>x₂ + α² ≤ (1/2)</code>",
  );
  assert.equal(
    formatForTelegramHtml("$$\\sqrt[3]{8} \\times \\sqrt{4}$$"),
    "<pre><code>³√8 × √4</code></pre>",
  );
});

test("formats links and prevents href attribute injection", () => {
  assert.equal(
    formatForTelegramHtml('[site](https://example.com/?q=" onclick="bad)'),
    '<a href="https://example.com/?q=&quot; onclick=&quot;bad">site</a>',
  );
  assert.equal(formatForTelegramHtml(""), "");
});

test("supports alternate math delimiters, grouped scripts, and text commands", () => {
  assert.equal(
    formatForTelegramHtml("\\[x^{12} + y_{34} = \\mathbf{A} \\text{ units}\\]"),
    "<pre><code>x¹² + y₃₄ = A units</code></pre>",
  );
  assert.equal(formatForTelegramHtml("\\(x^\\alpha + z^q\\)"), "<code>xα + zq</code>");
  assert.equal(formatForTelegramHtml("$\\mathrm{speed} \\& 5$"), "<code>speed &amp; 5</code>");
});

test("leaves unmatched Markdown and code fences as escaped plain text", () => {
  assert.equal(formatForTelegramHtml("**open <tag>"), "**open &lt;tag&gt;");
  assert.equal(formatForTelegramHtml("```unterminated"), "```unterminated");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { renderMarkdown } = require("../../inCircleClient/utils/markdown");

const root = path.resolve(__dirname, "../..");

test("AI Markdown renders common block and inline syntax", () => {
  const html = renderMarkdown([
    "## 今日总结",
    "",
    "- **重点**：保持节奏",
    "- `status`：正常",
    "",
    "> 这是一段引用",
    "",
    "```js",
    "const ready = true;",
    "```",
    "",
    "| 项目 | 状态 |",
    "| --- | --- |",
    "| Markdown | 完成 |",
    "",
    "[安全链接](https://example.com/docs)",
  ].join("\n"));

  assert.match(html, /<h2 class="md-heading md-h2"[^>]*>今日总结<\/h2>/);
  assert.match(html, /<ul class="md-list md-list-ul"[^>]*>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /class="md-inline-code"/);
  assert.match(html, /class="md-quote"/);
  assert.match(html, /class="md-code-block"/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
});

test("AI Markdown escapes raw HTML and blocks active or tracking content", () => {
  const html = renderMarkdown([
    "<script>alert('x')</script>",
    "",
    "[危险链接](javascript:alert('x'))",
    "",
    "[非加密链接](http://example.com)",
    "",
    "![远程图片](https://tracker.example/pixel.png)",
    "",
    "`<img src=x onerror=alert(1)>`",
  ].join("\n"));

  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /http:\/\/example\.com/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /class="md-image-placeholder"/);
});

test("AI Markdown removes trailing paragraph spacing from chat bubbles", () => {
  const singleLine = renderMarkdown("一行对话不应被额外撑高");
  const twoParagraphs = renderMarkdown("第一段\n\n第二段");

  assert.match(singleLine, /class="md-paragraph" style="margin:0;/);
  assert.doesNotMatch(singleLine, /margin:0 0 \.5em/);
  assert.equal((twoParagraphs.match(/margin:0 0 \.5em/g) || []).length, 1);
  assert.match(twoParagraphs, /style="margin:0;color:inherit;line-height:inherit;">第二段<\/p>$/);
});

test("AI Markdown removes the final paragraph gap inside blockquotes", () => {
  const singleQuote = renderMarkdown("> 因为我终于明白，熬夜对身体不好。");
  const multipleParagraphs = renderMarkdown("> 第一段\n>\n> 第二段");

  assert.match(singleQuote, /<blockquote[^>]+><p class="md-paragraph" style="margin:0;/);
  assert.doesNotMatch(singleQuote, /<blockquote[^>]+><p[^>]+margin:0 0 \.5em/);
  assert.equal((multipleParagraphs.match(/margin:0 0 \.5em/g) || []).length, 1);
  assert.match(multipleParagraphs, /第二段<\/p><\/blockquote>$/);
  assert.match(multipleParagraphs, /第二段<\/p>/);
  assert.doesNotMatch(multipleParagraphs, /第二段<\/p>\s*<p/);
});

test("AI chat uses the same Markdown view for reasoning and final answers", () => {
  const wxml = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-chat/index.wxml"), "utf8");
  const page = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-chat/index.js"), "utf8");

  assert.match(wxml, /nodes="\{\{item\.reasoningHtml\}\}"/);
  assert.match(wxml, /nodes="\{\{item\.contentHtml\}\}"/);
  assert.doesNotMatch(wxml, /item\.segments/);
  assert.match(page, /reasoningHtml[^\n]+markdown\.renderMarkdown/);
  assert.match(page, /contentHtml[^\n]+markdown\.renderMarkdown/);
});

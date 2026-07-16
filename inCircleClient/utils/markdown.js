const markedModule = require("../vendor/marked.min");

const marked = markedModule.marked || markedModule.parse || markedModule;
const Renderer = markedModule.Renderer;
const MAX_RENDER_CHARS = 100000;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeExternalUrl(value) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u0020\u007f]/.test(source)) return "";
  return /^https:\/\//i.test(source) ? source : "";
}

function languageLabel(value) {
  return String(value || "").trim().split(/\s+/)[0].slice(0, 32) || "代码";
}

function createRenderer() {
  const renderer = new Renderer();
  renderer.html = (html) => {
    const escaped = escapeHtml(html).replace(/\n/g, "<br>");
    return `<span class="md-raw-html" style="color:#7b8681;font-size:.9em;">${escaped}</span>`;
  };
  renderer.heading = (text, level) => {
    const safeLevel = Math.max(1, Math.min(6, Number(level || 1)));
    const sizes = ["1.25em", "1.17em", "1.08em", "1em", "1em", "1em"];
    return `<h${safeLevel} class="md-heading md-h${safeLevel}" style="margin:.75em 0 .35em;color:inherit;font-size:${sizes[safeLevel - 1]};font-weight:700;line-height:1.35;letter-spacing:0;">${text}</h${safeLevel}>`;
  };
  renderer.paragraph = (text) => `<p class="md-paragraph" style="margin:0 0 .5em;color:inherit;line-height:inherit;">${text}</p>`;
  renderer.blockquote = (quote) => {
    const content = normalizeTrailingParagraphSpacing(quote);
    return `<blockquote class="md-quote" style="margin:.55em 0;padding:.45em .6em;border-left:2px solid currentColor;border-radius:0 4px 4px 0;background:rgba(40,70,55,.06);color:inherit;">${content}</blockquote>`;
  };
  renderer.list = (body, ordered, start) => {
    const tag = ordered ? "ol" : "ul";
    const startValue = ordered && Number(start) > 1 ? ` start="${Math.floor(Number(start))}"` : "";
    const listStyle = ordered ? "decimal" : "disc";
    return `<${tag} class="md-list md-list-${tag}"${startValue} style="margin:.4em 0 .6em;padding-left:1.55em;color:inherit;list-style-type:${listStyle};">${body}</${tag}>`;
  };
  renderer.listitem = (text) => `<li class="md-list-item" style="display:list-item;margin:.18em 0;color:inherit;line-height:1.6;">${text}</li>`;
  renderer.code = (code, info) => {
    const language = escapeHtml(languageLabel(info));
    return `<div class="md-code-block" style="max-width:100%;margin:.6em 0;overflow:hidden;border-radius:5px;background:#202724;"><div class="md-code-label" style="padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.08);color:#aab5b0;font-size:.72em;">${language}</div><pre class="md-code-pre" style="display:block;margin:0;padding:8px;overflow:hidden;color:#eef5f1;font-family:monospace;font-size:.84em;line-height:1.55;white-space:pre-wrap;word-break:break-word;"><code>${escapeHtml(code)}</code></pre></div>`;
  };
  renderer.codespan = (code) => `<code class="md-inline-code" style="margin:0 2px;padding:1px 4px;border-radius:3px;background:rgba(40,53,47,.08);color:inherit;font-family:monospace;font-size:.88em;">${code}</code>`;
  renderer.link = (href, title, text) => {
    const safeUrl = safeExternalUrl(href);
    if (!safeUrl) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a class="md-link" href="${escapeHtml(safeUrl)}"${titleAttr} style="color:inherit;text-decoration:underline;">${text}</a>`;
  };
  renderer.image = (href, title, text) => {
    const alt = String(text || "").trim() || "图片";
    return `<span class="md-image-placeholder" style="color:#7b8681;font-size:.9em;">[图片: ${alt}]</span>`;
  };
  renderer.checkbox = (checked) => `<span class="md-checkbox" style="margin-right:4px;font-family:monospace;font-weight:700;">[${checked ? "x" : " "}]</span>`;
  renderer.table = (header, body) => `<table style="width:100%;margin:.6em 0;border-collapse:collapse;table-layout:fixed;"><thead>${header}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`;
  renderer.tablerow = (content) => `<tr>${content}</tr>`;
  renderer.tablecell = (content, flags) => {
    const tag = flags && flags.header ? "th" : "td";
    const align = flags && ["left", "center", "right"].includes(flags.align) ? flags.align : "left";
    const background = tag === "th" ? "background:rgba(40,70,55,.06);font-weight:700;" : "";
    return `<${tag} style="padding:5px;border:1px solid rgba(67,86,77,.13);text-align:${align};word-break:break-word;${background}">${content}</${tag}>`;
  };
  renderer.hr = () => '<hr class="md-divider" style="width:100%;height:1px;margin:.7em 0;border:0;background:rgba(67,86,77,.14);">';
  renderer.br = () => "<br>";
  return renderer;
}

const renderer = createRenderer();

function normalizeTrailingParagraphSpacing(value) {
  const html = String(value || "").trim();
  if (!html.endsWith("</p>")) return html;
  const paragraphStyle = '<p class="md-paragraph" style="margin:0 0 .5em;';
  const paragraphIndex = html.lastIndexOf(paragraphStyle);
  if (paragraphIndex < 0) return html;
  return `${html.slice(0, paragraphIndex)}${html.slice(paragraphIndex).replace(paragraphStyle, '<p class="md-paragraph" style="margin:0;')}`;
}

function fallbackHtml(source) {
  return `<p class="md-paragraph" style="margin:0;color:inherit;line-height:inherit;">${escapeHtml(source).replace(/\n/g, "<br>")}</p>`;
}

function renderMarkdown(value) {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  if (!source) return "";
  const renderSource = source.length > MAX_RENDER_CHARS
    ? `${source.slice(0, MAX_RENDER_CHARS)}\n\n[内容过长，展示已截断]`
    : source;
  try {
    const html = marked.parse(renderSource, {
      async: false,
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
      pedantic: false,
      renderer,
      silent: false,
    });
    return typeof html === "string" ? normalizeTrailingParagraphSpacing(html) : fallbackHtml(renderSource);
  } catch (error) {
    return fallbackHtml(renderSource);
  }
}

module.exports = {
  renderMarkdown,
};

// Escape-first mini-markdown for the definition preview. Pure — unit-tested
// without a DOM. Escaping happens BEFORE any tag insertion, so agent-written
// definition content can never smuggle markup into the page.

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMd(s) {
  return (
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Links to the split definition's own .md files only: they switch the
      // file shown in the panel (`data-def-link`), never navigate the iframe.
      // The path charset is closed, so nothing escaped above can break out.
      .replace(/\[([^\]]+)\]\(([\w./-]+\.md)\)/g, '<a href="#" class="def-link" data-def-link="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>")
  );
}

export function markdownToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (inList && !li) {
      out.push("</ul>");
      inList = false;
    }
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
    } else if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(li[1])}</li>`);
    } else if (quote) {
      out.push(`<blockquote>${inlineMd(quote[1])}</blockquote>`);
    } else if (line.trim() === "") {
      // paragraph break
    } else if (/^&lt;!--.*--&gt;$/.test(line.trim())) {
      // HTML comment (e.g. the generated-index marker) — not shown
    } else {
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

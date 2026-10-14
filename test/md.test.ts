import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS page module
import { escapeHtml, markdownToHtml } from "../page/md.js";

describe("definition preview markdown", () => {
  it("escapes HTML before any tag insertion", () => {
    const html = markdownToHtml('# Hi <script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headings, lists, and inline marks", () => {
    const html = markdownToHtml("# Title\n## Sub\n- item **bold** `code`\n\nPara *it*");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Sub</h2>");
    expect(html).toContain("<li>item <b>bold</b> <code>code</code></li>");
    expect(html).toContain("<p>Para <i>it</i></p>");
  });
  it("renders definition-file links as in-panel links, never other URLs", () => {
    const html = markdownToHtml(
      "- [Flows](project-definition/flows.md) — s\n> Depends on: [PROJECT_DEFINITION.md](../PROJECT_DEFINITION.md)\n[x](javascript:alert(1))",
    );
    expect(html).toContain('<a href="#" class="def-link" data-def-link="project-definition/flows.md">Flows</a>');
    expect(html).toContain('<blockquote>Depends on: <a href="#" class="def-link" data-def-link="../PROJECT_DEFINITION.md">');
    expect(html).not.toContain("javascript:alert(1)\"");
    expect(html).toContain("[x](javascript:alert(1))");
  });


  it("escapeHtml handles all four specials", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

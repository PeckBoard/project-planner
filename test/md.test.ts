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

  it("escapeHtml handles all four specials", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

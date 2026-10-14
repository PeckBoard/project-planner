// The split definition layout. Pure — unit-testable without an Extism runtime.
//
// A repo's definition is no longer one file the agent re-reads in full on
// every question. The root PROJECT_DEFINITION.md holds the overview (purpose
// and goals) plus a generated index linking one file per section under
// `project-definition/`. Each section file opens with a header declaring that
// it depends on the root file. The agent is handed the root (small) every
// turn and fetches a section's full text only when a question needs it.

export const DEFINITION_FILE = "PROJECT_DEFINITION.md";
export const SECTIONS_DIR = "project-definition";
/** The root file's own section id: purpose + goals live there. */
export const OVERVIEW = "overview";

export interface SectionDef {
  id: string;
  title: string;
}

/** Fixed, ordered section set. Ids double as file stems. */
export const SECTIONS: SectionDef[] = [
  { id: "users-stories", title: "Users & Stories" },
  { id: "flows", title: "Flows" },
  { id: "architecture", title: "Architecture" },
  { id: "technology", title: "Technology" },
  { id: "deployment-operations", title: "Deployment & Operations" },
  { id: "open-questions", title: "Open Questions" },
];

export const SECTION_IDS: string[] = [OVERVIEW, ...SECTIONS.map((s) => s.id)];

/** Marks the generated index in the root file; everything above it is the
 * agent-written overview. Its presence also tells a split root from a legacy
 * single-file definition. */
export const INDEX_MARKER = "<!-- project-planner:sections — generated; edit the linked files, not this list -->";
const INDEX_HEADING = "## Sections";
const DEPENDS_PREFIX = "> Depends on:";

export function isSection(id: unknown): id is string {
  return typeof id === "string" && SECTION_IDS.includes(id);
}

export function sectionTitle(id: string): string {
  if (id === OVERVIEW) return "Overview";
  return SECTIONS.find((s) => s.id === id)?.title ?? id;
}

function inRepo(repo: string, rel: string): string {
  return repo === "." ? rel : `${repo}/${rel}`;
}

/** Root file path — INSIDE the repo, so it is committed with the code. */
export function rootPath(repo: string): string {
  return inRepo(repo, DEFINITION_FILE);
}

/** Path of one section's file (`overview` → the root file). */
export function sectionPath(repo: string, id: string): string {
  return id === OVERVIEW ? rootPath(repo) : inRepo(repo, `${SECTIONS_DIR}/${id}.md`);
}

// ── Section files ───────────────────────────────────────────────────────────

/** Strip what the plugin owns from agent-written section markdown: a leading
 * `# Title` and the depends-on header, so re-writes never stack them. */
export function sectionBody(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };
  skipBlank();
  if (i < lines.length && /^#\s/.test(lines[i])) {
    i++;
    skipBlank();
  }
  while (i < lines.length && lines[i].startsWith(DEPENDS_PREFIX)) {
    i++;
    skipBlank();
  }
  return lines.slice(i).join("\n").trimEnd();
}

/** A section file's full content: title, the dependency header pointing back
 * at the root definition, then the body. */
export function sectionFile(id: string, body: string): string {
  const clean = sectionBody(body);
  return (
    `# ${sectionTitle(id)}\n\n` +
    `${DEPENDS_PREFIX} [${DEFINITION_FILE}](../${DEFINITION_FILE}) — this file is one section ` +
    `of that project definition; read it first. Nothing here may contradict its Purpose and Goals.\n` +
    (clean ? `\n${clean}\n` : "")
  );
}

// ── Root file ───────────────────────────────────────────────────────────────

export interface IndexEntry {
  id: string;
  exists: boolean;
  summary: string;
}

/** Split a root file into its overview and the index summaries. */
export function parseRoot(content: string): { overview: string; summaries: Record<string, string> } {
  const text = content.replace(/\r\n/g, "\n");
  const at = text.indexOf(INDEX_MARKER);
  if (at < 0) return { overview: text.trimEnd(), summaries: {} };
  let overview = text.slice(0, at).trimEnd();
  if (overview.endsWith(INDEX_HEADING)) overview = overview.slice(0, -INDEX_HEADING.length).trimEnd();
  const summaries: Record<string, string> = {};
  for (const line of text.slice(at + INDEX_MARKER.length).split("\n")) {
    const m = line.match(/\(project-definition\/([a-z-]+)\.md\)\s*—\s*(.*)$/);
    if (m && isSection(m[1])) summaries[m[1]] = m[2].trim();
  }
  return { overview, summaries };
}

/** The root file: the overview, then the generated section index. Written
 * sections are links with their one-line summary; unwritten ones are named
 * so the reader knows the section exists but is still empty. */
export function rootFile(overview: string, entries: IndexEntry[]): string {
  const lines = entries.map((e) => {
    const title = sectionTitle(e.id);
    if (!e.exists) return `- ${title} — not written yet`;
    return `- [${title}](${SECTIONS_DIR}/${e.id}.md) — ${e.summary || "no summary yet"}`;
  });
  return `${overview.trimEnd()}\n\n${INDEX_HEADING}\n\n${INDEX_MARKER}\n\n${lines.join("\n")}\n`;
}

export function isSplitRoot(content: string): boolean {
  return content.includes(INDEX_MARKER);
}

/** Empty overview skeleton seeded when a section is written before the
 * overview exists. */
export const OVERVIEW_SKELETON = "# Project Definition\n\n## Purpose\n\n## Goals";

// ── Legacy single-file migration ────────────────────────────────────────────

/** Heading text → section id, for splitting a legacy single-file definition.
 * Purpose/Goals and anything unrecognised stay in the overview. */
const ALIASES: Array<[RegExp, string]> = [
  [/^(users?( (and|&) (user )?stories)?|user stories|personas?|audience)$/, "users-stories"],
  [/^(user )?flows?$/, "flows"],
  [/^architecture$/, "architecture"],
  [/^(technology|tech stack|stack|technology choices)$/, "technology"],
  [/^(deployment|operations|monitoring|deployment (and|&) operations|ops)$/, "deployment-operations"],
  [/^open questions?$/, "open-questions"],
];

function headingSection(heading: string): string | null {
  const norm = heading.toLowerCase().replace(/[`*_]/g, "").trim();
  for (const [re, id] of ALIASES) {
    if (re.test(norm)) return id;
  }
  return null;
}

/** Split a legacy single-file definition by its `## ` headings. Nothing is
 * dropped: content under an unrecognised heading stays in the overview. */
export function splitLegacy(markdown: string): { overview: string; sections: Record<string, string> } {
  const overview: string[] = [];
  const sections: Record<string, string[]> = {};
  let target: string[] = overview;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h) {
      const id = headingSection(h[1]);
      if (id) {
        target = sections[id] ??= [];
        continue;
      }
      target = overview;
    }
    target.push(line);
  }
  const out: Record<string, string> = {};
  for (const [id, lines] of Object.entries(sections)) {
    const body = lines.join("\n").trim();
    if (body) out[id] = body;
  }
  return { overview: overview.join("\n").trimEnd(), sections: out };
}

// The plugin manifest JSON body — identity, hooks, permissions, the three MCP
// tools the planner session reports through, the slideshow page + its
// authenticated data routes.

const DESCRIPTION =
  "Project Planner: build a project definition file by interview, per git " +
  "repo. Pick a repo (a folder can hold several); a slideshow then asks one " +
  "pointed question per slide — fill-in-the-blank or multiple choice with " +
  "every option justified, plus small diagrams — in batches of up to 10 " +
  "independent questions from a dedicated agent session; a follow-up that " +
  "depends on an open answer waits for a later batch. When the repo's code already " +
  "answers a question, the slide proposes that answer with evidence for one-click " +
  "confirmation. Once a batch is answered, one run writes every answer as a " +
  "requirement into the repo's split " +
  "definition: PROJECT_DEFINITION.md holds purpose, goals and an index linking one " +
  "file per section under project-definition/, so each question reads only what it " +
  "needs. An existing definition is read first (a single-file one is split) and the " +
  "interview continues from it. Each repo's interview resets independently.";
// Single source of truth for the version: package.json. Bundled in by
// esbuild/vitest (resolveJsonModule) — never hardcode a version string here;
// a manifest that self-reports an old version makes the registry's
// "upgrade available" chip permanent (0.3.0 shipped that way).
import { version as VERSION } from "../package.json";
import { MAX_BATCH } from "./prompt";
import { SECTION_IDS } from "./sections";

const REPOSITORY = "https://github.com/peckboard/project-planner";
// Inline SVG (lucide "clipboard-list") for the page items; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
  '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
  '<path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>';

// One slide of a project_planner_ask batch.
const SLIDE_SCHEMA = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: SECTION_IDS,
      description:
        "The definition section this question's answer will be recorded in. 'overview' = " +
        "purpose and goals (and the starting-topic slide).",
    },
    topic: {
      type: "string",
      description: "Short area label for the slide chip, e.g. 'Purpose', 'Users', 'Database', 'Deployment'.",
    },
    kind: {
      type: "string",
      enum: ["choice", "fill"],
      description: "choice = multiple choice; fill = fill-in-the-blank.",
    },
    question: {
      type: "string",
      description:
        "The one question, in simple language, no lists, self-contained. For 'fill', write " +
        "the sentence with a ___ where the blank goes.",
    },
    why: {
      type: "string",
      description:
        "One or two plain sentences justifying the problem: what this decides and why it " +
        "matters for THIS project. Shown on the slide.",
    },
    options: {
      type: "array",
      description:
        "For kind 'choice': 2-5 options. Each label is short; each detail is one sentence " +
        "justifying the option and naming its trade-off, so options can be compared.",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          detail: { type: "string" },
        },
        required: ["label", "detail"],
        additionalProperties: false,
      },
    },
    multi: {
      type: "boolean",
      description: "For kind 'choice': allow picking more than one option. Default false.",
    },
    blank_hint: {
      type: "string",
      description: "For kind 'fill': a short example answer shown as the input placeholder.",
    },
    diagram: {
      type: "string",
      description:
        "Optional small mermaid source (flowchart or sequence, at most ~12 nodes) picturing " +
        "the problem or the options. Omit when it would not help.",
    },
    proposed_answer: {
      type: "string",
      description:
        "When the folder's existing code already answers this question: the conclusion the " +
        "code supports, phrased as the answer. The slide shows it with a one-click Confirm " +
        "and the user may correct it instead. For 'choice', match an option label when one " +
        "fits. Requires `evidence`. Omit when the code is silent — never propose a guess.",
    },
    evidence: {
      type: "string",
      description:
        "Required with proposed_answer: one plain sentence naming where the code shows it, " +
        "e.g. 'Cargo.toml declares Axum with Diesel/SQLite'. Shown to the user under the " +
        "proposal so they can judge it.",
    },
    from_queue: {
      type: "string",
      description:
        "When this question asks a pending-queue entry: that exact entry. It leaves the " +
        "queue when the batch is published.",
    },
  },
  required: ["topic", "section", "kind", "question", "why"],
  additionalProperties: false,
};
export function manifestJson(): string {
  const manifest = {
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,

    hooks: ["mcp.tool.invoke", "http.request.before", "http.request.authed"],

    permissions: [
      "provide_mcp_tools", // the planner session reports back through our tools
      "data_store", // per-folder interview state (question, queue, history)
      "models_read", // model picker on the start slide
      "session_write", // create the temp planner session
      "session_dispatch", // dispatch the kickoff prompt + each answer
      "session_control", // clear_first on the answer dispatch — reset the session's context per question
      "session_read", // poll the slim event tail (is the run still going?)
      "session_prompt_write", // refresh the planner contract on an existing session
      "project_files_read", // read the existing definition files
      "project_files_write", // write the definition files after each answer
      "user_authority", // serve the authenticated slideshow data routes
      "contribute_sidebar", // the page items below
    ],

    // The ONLY launch surface is the repo browser: `repo_scoped: true` tells
    // core to hide this from every folder-level surface (the Folders row,
    // the repo-list header) and offer it per repo row instead, opening the
    // page with `?repo=<path>`. It stays a `folder_items` entry because that
    // is what carries the folder scope header the page's host calls need —
    // and deliberately NOT `sidebar_items` (a global page carries no scope
    // header at all). No project/session items: the planner is a per-repo
    // tool, and surfacing it per folder-ish contexts is what confused it.
    folder_items: [
      {
        id: "project-planner",
        label: "Project Planner",
        icon: ICON,
        path: "/plugin-api/v1/project-planner",
        repo_scoped: true,
      },
    ],

    http_routes: ["GET /plugin-api/v1/project-planner"],

    ui_routes: [
      "GET /api/plugin-ui/project-planner/repos",
      "GET /api/plugin-ui/project-planner/state",
      "POST /api/plugin-ui/project-planner/start",
      "POST /api/plugin-ui/project-planner/answer",
      "POST /api/plugin-ui/project-planner/back",
      "POST /api/plugin-ui/project-planner/reset",
    ],

    // The agent-facing contract. `peckboard_session_events` is slim (never
    // payloads), so the ONLY way the planner session's output reaches this
    // plugin is through these tools.
    mcp_tools: [
      {
        name: "project_planner_ask",
        description:
          `Show the user the next BATCH of the project-planning interview: 1 to ${MAX_BATCH} slides, ` +
          "each with exactly ONE pointed question, either fill-in-the-blank or multiple choice. The " +
          "user answers them one after another and all answers arrive together as the next message. " +
          "Every question in the batch must make sense whatever the user answers to the others: " +
          "never include a follow-up that depends on another question of the same batch (queue it " +
          "with project_planner_queue instead). Options must each carry a short justification (why " +
          "one would pick it, and its trade-off). Include `why` — one or two plain sentences that " +
          "justify the problem the question settles, so each slide is understandable on its own. " +
          "Optionally attach a small mermaid diagram that pictures the problem or the compared " +
          "options. After calling this, END YOUR TURN.",
        input_schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: MAX_BATCH,
              description: "The batch: mutually independent questions, shown in this order.",
              items: SLIDE_SCHEMA,
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
      {
        name: "project_planner_queue",
        description:
          "Save follow-up questions for a later batch instead of asking them now. Use this for a " +
          "question that depends on the answer to another question still open (e.g. 'what should X " +
          "do' while 'X or Y' is unanswered), or for parts of a topic too complex for one batch. " +
          "Each entry is one short line describing a question still to be asked. The current queue " +
          "is shown to you every turn; remove entries that answers made moot by passing `remove` " +
          "(entries a published slide names in from_queue are removed for you).",
        input_schema: {
          type: "object",
          properties: {
            add: {
              type: "array",
              items: { type: "string" },
              description: "Questions to add to the pending queue (short one-liners).",
            },
            remove: {
              type: "array",
              items: { type: "string" },
              description: "Exact entries to delete from the queue (asked, or no longer relevant).",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "project_planner_write_definition",
        description:
          "Write ONE section of the repo's split project definition. PROJECT_DEFINITION.md holds " +
          "the overview (purpose, goals) and an index the plugin generates; every other section " +
          "is its own file under project-definition/, whose title and depends-on header the " +
          "plugin adds. Call this after every answer: take the question and its answer and add " +
          "ONE requirement to the section — or amend the existing requirement it changes — " +
          "keeping the rest of the section intact. Requirements are short declarative sentences " +
          "with their justification. Also call it once at the start with section 'overview' if " +
          "no definition exists yet, seeding the skeleton.",
        input_schema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: SECTION_IDS,
              description: "Which section to write. 'overview' = the root file's purpose and goals.",
            },
            markdown: {
              type: "string",
              description:
                "The complete new body of that section (for 'overview': title, Purpose and Goals; " +
                "the section index is appended for you).",
            },
            summary: {
              type: "string",
              description:
                "For a non-overview section: one short line summarizing the WHOLE section, shown " +
                "next to its link in the index so later turns can decide whether to read it.",
            },
            note: {
              type: "string",
              description:
                "One short line describing what changed (shown on the slide's progress trail).",
            },
          },
          required: ["section", "markdown"],
          additionalProperties: false,
        },
      },
      {
        name: "project_planner_read_section",
        description:
          "Read one section of the repo's split project definition in full. The index you are " +
          "given each turn names every section with a one-line summary; call this only when the " +
          "next question depends on a section's details. Never read every section.",
        input_schema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: SECTION_IDS,
              description: "Which section to read. 'overview' = the root file.",
            },
          },
          required: ["section"],
          additionalProperties: false,
        },
      },
      {
        name: "project_planner_finish",
        description:
          "End the interview: the definition now covers purpose, goals, users and their stories, " +
          "architecture, technology choices, deployment, and monitoring, and the pending queue is " +
          "empty. Shows the user a completion slide with your summary.",
        input_schema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Two or three plain sentences: what the definition now pins down.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      },
    ],
  };
  return JSON.stringify(manifest);
}

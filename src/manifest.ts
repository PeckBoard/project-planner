// The plugin manifest JSON body — identity, hooks, permissions, the three MCP
// tools the planner session reports through, the slideshow page + its
// authenticated data routes.

const DESCRIPTION =
  "Project Planner: build a project definition file by interview, per git " +
  "repo. Pick a repo (a folder can hold several); a slideshow then asks one " +
  "pointed question per slide — fill-in-the-blank or multiple choice with " +
  "every option justified, plus small diagrams — generated one after another " +
  "by a dedicated agent session. When the repo's code already answers a " +
  "question, the slide proposes that answer with evidence for one-click " +
  "confirmation. Each answer is written into the repo's PROJECT_DEFINITION.md " +
  "as a requirement; an existing definition is read first and the interview " +
  "continues from it. Each repo's interview resets independently.";
const VERSION = "0.2.2";

const REPOSITORY = "https://github.com/peckboard/project-planner";
// Inline SVG (lucide "clipboard-list") for the page items; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
  '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
  '<path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>';

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
      "session_read", // poll the slim event tail (is the run still going?)
      "session_prompt_write", // refresh the planner contract on an existing session
      "project_files_read", // read an existing PROJECT_DEFINITION.md
      "project_files_write", // write the definition after each answer
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
      "POST /api/plugin-ui/project-planner/reset",
    ],

    // The agent-facing contract. `peckboard_session_events` is slim (never
    // payloads), so the ONLY way the planner session's output reaches this
    // plugin is through these tools.
    mcp_tools: [
      {
        name: "project_planner_ask",
        description:
          "Show the user the next slide of the project-planning interview: exactly ONE pointed " +
          "question, either fill-in-the-blank or multiple choice. Options must each carry a short " +
          "justification (why one would pick it, and its trade-off). Include `why` — one or two " +
          "plain sentences that justify the problem this question settles, so the slide is " +
          "understandable on its own. Optionally attach a small mermaid diagram that pictures the " +
          "problem or the compared options. After calling this, END YOUR TURN — the user's answer " +
          "arrives as the next message.",
        input_schema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description:
                "Short area label for the slide chip, e.g. 'Purpose', 'Users', 'Database', 'Deployment'.",
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
          },
          required: ["topic", "kind", "question", "why"],
          additionalProperties: false,
        },
      },
      {
        name: "project_planner_queue",
        description:
          "Save follow-up questions for later instead of asking them now. Use this when a topic is " +
          "too complex for one slide: split it and queue the parts. Each entry is one short line " +
          "describing a question still to be asked. The current queue is shown to you with every " +
          "answer; pick the most valuable entry next and remove entries you have asked or that " +
          "answers made moot by passing `remove`.",
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
          "Write the FULL updated PROJECT_DEFINITION.md to the folder root. Call this after every " +
          "answer: take the question and its answer and add ONE requirement — or amend the existing " +
          "requirement it changes — keeping everything else intact. Requirements are short " +
          "declarative sentences with their justification. Also call it once at the start if no " +
          "definition file exists yet, seeding the skeleton.",
        input_schema: {
          type: "object",
          properties: {
            markdown: {
              type: "string",
              description: "The complete new content of PROJECT_DEFINITION.md.",
            },
            note: {
              type: "string",
              description:
                "One short line describing what changed (shown on the slide's progress trail).",
            },
          },
          required: ["markdown"],
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

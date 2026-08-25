import { beforeEach, describe, expect, it } from "vitest";
import { docStore, hostCalls, setHandlers } from "./fakeHost";
import {
  answer,
  definitionPath,
  discoverRepos,
  emptyState,
  normalizeRepo,
  pageState,
  repoList,
  reset,
  start,
  toolAsk,
  toolFinish,
  toolQueue,
  toolWriteDefinition,
} from "../src/planner";

const FOLDER = "f1";
const SESSION = "s1";
const REPO = "apps/web";
const KEY = `planner/${FOLDER}|${REPO}`;

/** Handlers for a healthy running interview in a folder that holds two git
 * repos (`apps/web`, `tools/cli`) and loose files outside both. */
function baseHandlers(docs: ReturnType<typeof docStore>) {
  return {
    ...docs.handlers,
    peckboard_caller_scope: () => ({ folder_id: FOLDER, authority: true }),
    peckboard_create_session: () => ({ session: { id: SESSION } }),
    peckboard_dispatch_capture: () => ({}),
    peckboard_list_project_files: () => ({
      files: [
        { path: "apps/web/src/main.ts", size: 10 },
        { path: "apps/web/package.json", size: 10 },
        { path: "tools/cli/go.mod", size: 10 },
        { path: "docs/notes.md", size: 10 },
      ],
      truncated: false,
    }),
    peckboard_read_file: ({ path }: any) => {
      if (path === "apps/web/.git/HEAD") return { content: "ref: refs/heads/main\n" };
      if (path === "tools/cli/.git/HEAD") return { content: "ref: refs/heads/trunk\n" };
      return { error: "file not found" };
    },
    peckboard_write_file: () => ({ ok: true }),
    peckboard_session_events: () => ({ events: [], latest_seq: null }),
    peckboard_list_sessions_brief: () => ({ sessions: [{ session_id: SESSION }] }),
    peckboard_list_models: () => ({
      models: [{ id: "mock:happy-path", display_name: "Mock", provider: "mock", account_id: null, thinking: true, tier: 1 }],
    }),
  };
}

// Core sends the invoke context CAMEL-CASE ({sessionId, folderId} — see
// peckboard/src/service/mcp_server/mod.rs dispatch_tool_call). The fixture
// mirrors that exactly; reading snake_case here was the 0.1.0 bug.
const ctx = { folderId: FOLDER, sessionId: SESSION };

/** A running interview for REPO plus the session→repo mapping start() writes. */
function runningState(docs: ReturnType<typeof docStore>) {
  docs.docs[KEY] = { ...emptyState(), status: "thinking", session_id: SESSION, model: "m" };
  docs.docs[`sessions/${SESSION}`] = { folder_id: FOLDER, repo: REPO };
}

let docs: ReturnType<typeof docStore>;
beforeEach(() => {
  docs = docStore();
  setHandlers(baseHandlers(docs));
});

describe("repo scoping", () => {
  it("normalizes repo paths ('' and './x' and trailing slash)", () => {
    expect(normalizeRepo("")).toBe(".");
    expect(normalizeRepo(undefined)).toBe(".");
    expect(normalizeRepo("./apps/web/")).toBe("apps/web");
  });

  it("puts the definition file INSIDE the repo", () => {
    expect(definitionPath(".")).toBe("PROJECT_DEFINITION.md");
    expect(definitionPath("apps/web")).toBe("apps/web/PROJECT_DEFINITION.md");
  });

  it("discovers each git repo in the folder from the jailed walk", () => {
    const repos = discoverRepos();
    expect(repos.map((r) => [r.path, r.branch])).toEqual([
      ["apps/web", "main"],
      ["tools/cli", "trunk"],
    ]);
  });

  it("a folder-root repo claims the whole tree", () => {
    setHandlers({
      ...baseHandlers(docs),
      peckboard_read_file: ({ path }: any) =>
        path === ".git/HEAD" ? { content: "ref: refs/heads/main\n" } : { error: "not found" },
    });
    const repos = discoverRepos();
    expect(repos.map((r) => r.path)).toEqual(["."]);
  });

  it("repoList reports each repo's interview status independently", () => {
    runningState(docs);
    const { repos } = repoList(FOLDER);
    expect(repos.find((r: any) => r.path === REPO).status).toBe("thinking");
    expect(repos.find((r: any) => r.path === "tools/cli").status).toBe("idle");
  });
});

describe("start", () => {
  it("creates a temp session for the repo and dispatches a repo-scoped kickoff", () => {
    start(FOLDER, REPO, "mock:happy-path");
    const create = hostCalls.find((c) => c.name === "peckboard_create_session");
    expect(create?.input.is_temp).toBe(true);
    expect(create?.input.system_prompt).toContain("project_planner_ask");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain(`'${REPO}'`);
    expect(dispatch?.input.prompt).toMatch(/seed the skeleton/);
    expect((docs.docs[KEY] as any).status).toBe("thinking");
    expect(docs.docs[`sessions/${SESSION}`]).toEqual({ folder_id: FOLDER, repo: REPO });
  });

  it("refuses a path that is not a git repo", () => {
    expect(() => start(FOLDER, "docs", "m")).toThrow(/not a git repo/);
  });

  it("refuses while this repo's interview is already running", () => {
    runningState(docs);
    expect(() => start(FOLDER, REPO, "m")).toThrow(/already running/);
  });

  it("another repo in the same folder starts independently", () => {
    runningState(docs);
    expect(() => start(FOLDER, "tools/cli", "mock:happy-path")).not.toThrow();
  });
});

describe("project_planner_ask", () => {
  beforeEach(() => runningState(docs));

  it("publishes a valid slide and flips to waiting", () => {
    const r = toolAsk(
      {
        topic: "Purpose",
        kind: "choice",
        question: "What is this project for?",
        why: "Everything else depends on it.",
        options: [
          { label: "A shop", detail: "Sells things; needs payments." },
          { label: "A blog", detail: "Publishes posts; simpler to run." },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("waiting");
    expect(st.slide.slide_no).toBe(1);
  });

  it("rejects a slide without justification for the problem", () => {
    const r = toolAsk({ topic: "T", kind: "fill", question: "Name ___?", why: "" }, ctx);
    expect(r.error).toMatch(/why is required/);
  });

  it("only accepts the repo's own planner session", () => {
    expect(() =>
      toolAsk({ topic: "T", kind: "fill", question: "Q ___", why: "W." }, { folderId: FOLDER, sessionId: "intruder" }),
    ).toThrow(/reserved for the Project Planner/);
  });

  it("refuses a session whose interview was reset", () => {
    docs.docs[KEY] = emptyState(); // reset wiped session_id
    expect(() => toolAsk({ topic: "T", kind: "fill", question: "Q ___", why: "W." }, ctx)).toThrow(
      /reset or restarted/,
    );
  });

  it("refuses a second ask while a slide is unanswered", () => {
    toolAsk({ topic: "T", kind: "fill", question: "First ___?", why: "W." }, ctx);
    const r = toolAsk({ topic: "T", kind: "fill", question: "Second ___?", why: "W." }, ctx);
    expect(r.error).toMatch(/already showing and unanswered/);
  });

  it("requires evidence when the code proposes an answer", () => {
    const r = toolAsk(
      { topic: "Technology", kind: "fill", question: "The language is ___.", why: "W.", proposed_answer: "Rust" },
      ctx,
    );
    expect(r.error).toMatch(/evidence is required/);
  });

  it("stores a code-derived proposal with its evidence on the slide", () => {
    const r = toolAsk(
      {
        topic: "Technology",
        kind: "fill",
        question: "The language is ___.",
        why: "W.",
        proposed_answer: "TypeScript",
        evidence: "package.json declares a TS toolchain.",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const st = docs.docs[KEY] as any;
    expect(st.slide.proposed_answer).toBe("TypeScript");
    expect(st.slide.evidence).toMatch(/package.json/);
  });
});

describe("answer", () => {
  it("appends history and dispatches the answer prompt", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    setHandlers(baseHandlers(docs)); // clear the call log, keep the store
    answer(FOLDER, REPO, "selling hats");
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("thinking");
    expect(st.history[0].answer).toBe("selling hats");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain("selling hats");
  });

  it("refuses when no question is waiting", () => {
    expect(() => answer(FOLDER, REPO, "x")).toThrow(/no question waiting/);
  });
});

describe("project_planner_write_definition", () => {
  it("writes the file INTO the repo and pins the note", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", kind: "fill", question: "For ___?", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    const r = toolWriteDefinition({ markdown: "# Def\n- sells hats", note: "Recorded the purpose" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("apps/web/PROJECT_DEFINITION.md");
    const write = hostCalls.find((c) => c.name === "peckboard_write_file");
    expect(write?.input.path).toBe("apps/web/PROJECT_DEFINITION.md");
    const st = docs.docs[KEY] as any;
    expect(st.history[0].note).toBe("Recorded the purpose");
  });
});

describe("project_planner_queue / finish", () => {
  it("queue adds, dedupes, removes", () => {
    runningState(docs);
    toolQueue({ add: ["Which DB?", "Which DB?", "How deployed?"] }, ctx);
    toolQueue({ remove: ["Which DB?"] }, ctx);
    expect((docs.docs[KEY] as any).pending).toEqual(["How deployed?"]);
  });

  it("finish ends the interview with a summary", () => {
    runningState(docs);
    toolFinish({ summary: "Everything is pinned down." }, ctx);
    expect((docs.docs[KEY] as any).status).toBe("done");
  });
});

describe("pageState settling + reset", () => {
  it("nudges a run that ended without asking, then fails it", () => {
    runningState(docs);
    setHandlers({
      ...baseHandlers(docs),
      peckboard_session_events: () => ({
        events: [{ seq: 1, kind: "agent-end", name: null }],
        latest_seq: 1,
      }),
    });
    let s = pageState(FOLDER, REPO);
    expect(s.status).toBe("thinking"); // nudged, not failed
    pageState(FOLDER, REPO);
    s = pageState(FOLDER, REPO);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/without showing a slide/);
  });

  it("fails when the planner session vanished", () => {
    runningState(docs);
    setHandlers({
      ...baseHandlers(docs),
      peckboard_list_sessions_brief: () => ({ sessions: [] }),
    });
    expect(pageState(FOLDER, REPO).status).toBe("failed");
  });

  it("reset clears ONLY its repo's interview, never the file", () => {
    runningState(docs);
    docs.docs[`planner/${FOLDER}|tools/cli`] = { ...emptyState(), status: "done" };
    reset(FOLDER, REPO);
    expect((docs.docs[KEY] as any).status).toBe("idle");
    expect((docs.docs[`planner/${FOLDER}|tools/cli`] as any).status).toBe("done");
    expect(hostCalls.some((c) => c.name === "peckboard_write_file")).toBe(false);
  });

  it("state names the repo's own definition file", () => {
    const s = pageState(FOLDER, REPO);
    expect(s.repo).toBe(REPO);
    expect(s.definition_file).toBe("apps/web/PROJECT_DEFINITION.md");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { docStore, hostCalls, setHandlers } from "./fakeHost";
import {
  answer,
  back,
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
  toolReadSection,
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
    // Expert-classified so core hides it from session lists and a tab close
    // doesn't delete it.
    expect(create?.input.is_expert).toBe(true);
    expect(create?.input.expert_kind).toBe("project-planner");
    expect(create?.input.system_prompt).toContain("project_planner_ask");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain(`'${REPO}'`);
    expect(dispatch?.input.prompt).toMatch(/seed the skeleton/);
    expect(dispatch?.input.clear_first).toBe(false); // kickoff keeps the fresh session as-is
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
        topic: "Purpose", section: "overview",
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
    const r = toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Name ___?", why: "" }, ctx);
    expect(r.error).toMatch(/why is required/);
  });

  it("only accepts the repo's own planner session", () => {
    expect(() =>
      toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, { folderId: FOLDER, sessionId: "intruder" }),
    ).toThrow(/reserved for the Project Planner/);
  });

  it("refuses a session whose interview was reset", () => {
    docs.docs[KEY] = emptyState(); // reset wiped session_id
    expect(() => toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, ctx)).toThrow(
      /reset or restarted/,
    );
  });

  it("refuses a second ask while a slide is unanswered", () => {
    toolAsk({ topic: "T", section: "overview", kind: "fill", question: "First ___?", why: "W." }, ctx);
    const r = toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Second ___?", why: "W." }, ctx);
    expect(r.error).toMatch(/already showing and unanswered/);
  });

  it("requires evidence when the code proposes an answer", () => {
    const r = toolAsk(
      { topic: "Technology", section: "overview", kind: "fill", question: "The language is ___.", why: "W.", proposed_answer: "Rust" },
      ctx,
    );
    expect(r.error).toMatch(/evidence is required/);
  });

  it("stores a code-derived proposal with its evidence on the slide", () => {
    const r = toolAsk(
      {
        topic: "Technology", section: "overview",
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
describe("batches", () => {
  beforeEach(() => runningState(docs));
  const q = (question: string, section = "overview", extra: any = {}) => ({
    topic: "T", section, kind: "fill", question, why: "W.", ...extra,
  });

  it("collects every answer of a batch, then dispatches ONE record turn with all of them", () => {
    (docs.docs[KEY] as any).pending = ["Which DB?", "What should X do?"];
    const r = toolAsk(
      { questions: [q("Purpose is ___"), q("The DB is ___", "technology", { from_queue: "Which DB?" })] },
      ctx,
    );
    expect(r.ok).toBe(true);
    let st = docs.docs[KEY] as any;
    expect(st.slide.batch_index).toBe(1);
    expect(st.slide.batch_size).toBe(2);
    // The asked queue entry left the queue; the dependent one stays.
    expect(st.pending).toEqual(["What should X do?"]);

    setHandlers(baseHandlers(docs));
    answer(FOLDER, REPO, "selling hats");
    st = docs.docs[KEY] as any;
    expect(st.status).toBe("waiting");
    expect(st.slide.question).toBe("The DB is ___");
    expect(st.slide.slide_no).toBe(2);
    expect(hostCalls.some((c) => c.name === "peckboard_dispatch_capture")).toBe(false);

    answer(FOLDER, REPO, "SQLite");
    st = docs.docs[KEY] as any;
    expect(st.status).toBe("thinking");
    expect(st.stage).toBe("record");
    expect(st.history.map((h: any) => h.answer)).toEqual(["selling hats", "SQLite"]);
    const dispatches = hostCalls.filter((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].input.prompt).toContain("selling hats");
    expect(dispatches[0].input.prompt).toContain("SQLite");
    expect(dispatches[0].input.prompt).toMatch(/all 2 slides of the batch/);
  });

  it("rejects an oversized batch and names the bad question", () => {
    const big = Array.from({ length: 11 }, (_, i) => q(`Q${i} ___`));
    expect(toolAsk({ questions: big }, ctx).error).toMatch(/1 to 10 questions/);
    const r = toolAsk({ questions: [q("Fine ___"), { ...q("Bad ___"), why: "" }] }, ctx);
    expect(r.error).toMatch(/^question 2: why is required/);
    expect((docs.docs[KEY] as any).status).toBe("thinking");
  });

  it("back withdraws the previous answer, prefills it, and keeps the batch intact", () => {
    toolAsk({ questions: [q("A ___"), q("B ___"), q("C ___")] }, ctx);
    expect(() => back(FOLDER, REPO)).toThrow(/no earlier question/);
    answer(FOLDER, REPO, "first");
    answer(FOLDER, REPO, "second");
    setHandlers(baseHandlers(docs));
    back(FOLDER, REPO);
    let st = docs.docs[KEY] as any;
    expect(st.slide.question).toBe("B ___");
    expect(st.slide.previous_answer).toBe("second");
    expect(st.upcoming.map((s: any) => s.question)).toEqual(["C ___"]);
    expect(st.history.map((h: any) => h.answer)).toEqual(["first"]);
    answer(FOLDER, REPO, "second, revised");
    answer(FOLDER, REPO, "third");
    st = docs.docs[KEY] as any;
    expect(st.history.map((h: any) => h.answer)).toEqual(["first", "second, revised", "third"]);
    const dispatches = hostCalls.filter((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].input.prompt).toContain("second, revised");
    expect(dispatches[0].input.prompt).not.toMatch(/Answer: second\n/);
  });
});


describe("answer", () => {
  it("record turn: appends history and dispatches the answer WITHOUT a wipe", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    (docs.docs[KEY] as any).last_seq = 42; // pretend settleRun already read an event tail
    setHandlers(baseHandlers(docs)); // clear the call log, keep the store
    answer(FOLDER, REPO, "selling hats");
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("thinking");
    expect(st.stage).toBe("record");
    expect(st.history[0].answer).toBe("selling hats");
    // No wipe on this dispatch — the record turn keeps the context the
    // question was asked in, so the model can fold the answer in properly.
    expect(st.last_seq).toBe(42);
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain("selling hats");
    expect(dispatch?.input.prompt).toMatch(/Do NOT call project_planner_ask/);
    expect(dispatch?.input.clear_first).toBe(false);
  });

  it("asking is refused until the answer is recorded and the context reset", () => {
    runningState(docs);
    toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    const r = toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Next ___", why: "W." }, ctx);
    expect(r.error).toMatch(/first record the answer/);
  });

  it("the definition write completes the record phase", () => {
    runningState(docs);
    toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    toolWriteDefinition({ section: "overview", markdown: "# Def" }, ctx);
    expect((docs.docs[KEY] as any).stage).toBe("recorded");
  });

  it("after the record turn ends, the ask turn goes out WITH the wipe", () => {
    runningState(docs);
    toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    toolWriteDefinition({ section: "overview", markdown: "# Def" }, ctx);
    setHandlers({
      ...baseHandlers(docs),
      peckboard_session_events: () => ({
        events: [{ seq: 7, kind: "agent-end", name: null }],
        latest_seq: 7,
      }),
    });
    const s = pageState(FOLDER, REPO);
    expect(s.status).toBe("thinking");
    const st = docs.docs[KEY] as any;
    expect(st.stage).toBe(null);
    // The wipe restarts event seq at 1 — a stale high-water mark would make
    // settleRun skip every post-clear event and blind the watchdog.
    expect(st.last_seq).toBe(0);
    expect(st.wipe_seq).toBe(7); // the pre-wipe log's end, held until the wipe lands
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.clear_first).toBe(true);
    expect(dispatch?.input.prompt).toMatch(/chat history was reset/);
  });

  it("a record turn that ends without writing is nudged to record", () => {
    runningState(docs);
    toolAsk({ topic: "T", section: "overview", kind: "fill", question: "Q ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    setHandlers({
      ...baseHandlers(docs),
      peckboard_session_events: () => ({
        events: [{ seq: 7, kind: "agent-end", name: null }],
        latest_seq: 7,
      }),
    });
    pageState(FOLDER, REPO);
    const nudge = hostCalls.filter((c) => c.name === "peckboard_dispatch_capture").pop();
    expect(nudge?.input.prompt).toMatch(/without recording the user's answer/);
    expect(nudge?.input.clear_first).toBe(false);
  });

  it("the ask turn's own agent-end is not mistaken for the record turn ending", () => {
    // The session log as it stands when the user answers: the turn that
    // published the slide has ended. The watchdog doesn't read while a slide
    // waits, so that agent-end is still past the stored high-water mark.
    const log = [
      { seq: 1, kind: "agent-start", name: null },
      { seq: 2, kind: "agent-tool-end", name: "project_planner_ask" },
      { seq: 3, kind: "agent-end", name: null },
    ];
    const tail = ({ after_seq }: any) => {
      const events = log.filter((e) => e.seq > (after_seq ?? 0));
      return { events, latest_seq: events.length ? events[events.length - 1].seq : null };
    };
    runningState(docs);
    setHandlers({ ...baseHandlers(docs), peckboard_session_events: tail });
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "selling hats");
    expect((docs.docs[KEY] as any).last_seq).toBe(3);

    // The page polls immediately after posting the answer: the record turn
    // has not ended, so nothing may be dispatched on top of the answer.
    setHandlers({ ...baseHandlers(docs), peckboard_session_events: tail });
    pageState(FOLDER, REPO);
    expect(hostCalls.filter((c) => c.name === "peckboard_dispatch_capture")).toEqual([]);
    const st = docs.docs[KEY] as any;
    expect(st.stage).toBe("record");
    expect(st.nudges).toBe(0);
  });
  it("a late agent-end of the ask turn is not taken for the record turn's", () => {
    // The user answers while the turn that published the slide is still
    // running: its agent-end is not in the log yet when answer() drains it.
    const log = [
      { seq: 1, kind: "agent-start", name: null },
      { seq: 2, kind: "agent-tool-end", name: "project_planner_ask" },
    ];
    const tail = ({ after_seq }: any) => {
      const events = log.filter((e) => e.seq > (after_seq ?? 0));
      return { events, latest_seq: events.length ? events[events.length - 1].seq : null };
    };
    runningState(docs);
    setHandlers({ ...baseHandlers(docs), peckboard_session_events: tail });
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "selling hats");
    expect((docs.docs[KEY] as any).turn_open).toBe(1);

    // The ask turn wraps up AFTER the record prompt went out.
    log.push({ seq: 3, kind: "agent-end", name: null });
    setHandlers({ ...baseHandlers(docs), peckboard_session_events: tail });
    pageState(FOLDER, REPO);
    expect(hostCalls.filter((c) => c.name === "peckboard_dispatch_capture")).toEqual([]);
    let st = docs.docs[KEY] as any;
    expect(st.stage).toBe("record");
    expect(st.nudges).toBe(0);

    // The record turn itself ends without writing: THAT one is nudged.
    log.push({ seq: 4, kind: "agent-start", name: null }, { seq: 5, kind: "agent-end", name: null });
    setHandlers({ ...baseHandlers(docs), peckboard_session_events: tail });
    pageState(FOLDER, REPO);
    const nudge = hostCalls.filter((c) => c.name === "peckboard_dispatch_capture").pop();
    expect(nudge?.input.prompt).toMatch(/without recording the user's answer/);
    st = docs.docs[KEY] as any;
    expect(st.nudges).toBe(1);
  });

  it("polls before the wipe lands neither settle on the old log nor blind the watchdog", () => {
    // The session log as the record turn (which wrote the definition) ends.
    let log = [
      { seq: 1, kind: "agent-start", name: null },
      { seq: 2, kind: "agent-end", name: null },
      { seq: 3, kind: "agent-start", name: null },
      { seq: 4, kind: "agent-tool-end", name: "project_planner_write_definition" },
      { seq: 5, kind: "agent-end", name: null },
    ];
    const tail = ({ after_seq, limit }: any) => {
      const events = log.filter((e) => e.seq > (after_seq ?? 0)).slice(0, limit ?? 200);
      return { events, latest_seq: events.length ? events[events.length - 1].seq : null };
    };
    const handlers = () => ({ ...baseHandlers(docs), peckboard_session_events: tail });
    const dispatches = () => hostCalls.filter((c) => c.name === "peckboard_dispatch_capture");
    runningState(docs);
    Object.assign(docs.docs[KEY] as any, { stage: "recorded", last_seq: 2 });
    setHandlers(handlers());
    pageState(FOLDER, REPO); // record turn ended → wipe + ask dispatch
    expect(dispatches().map((c) => c.input.clear_first)).toEqual([true]);
    expect((docs.docs[KEY] as any).wipe_seq).toBe(5);

    // The page polls again before core's wipe has run: the old log, with the
    // record turn's agent-end, is still all there is.
    setHandlers(handlers());
    pageState(FOLDER, REPO);
    expect(dispatches()).toEqual([]);
    let st = docs.docs[KEY] as any;
    expect(st.nudges).toBe(0);
    expect(st.wipe_seq).toBe(5);

    // The wipe lands and the fresh ask turn is under way — seq restarts at 1.
    log = [
      { seq: 1, kind: "agent-start", name: null },
      { seq: 2, kind: "agent-text", name: null },
    ];
    setHandlers(handlers());
    pageState(FOLDER, REPO);
    expect(dispatches()).toEqual([]);
    st = docs.docs[KEY] as any;
    expect(st.wipe_seq).toBe(null);
    expect(st.last_seq).toBe(2);

    // That turn ends without asking: the watchdog sees it and nudges.
    log.push({ seq: 3, kind: "agent-end", name: null });
    setHandlers(handlers());
    pageState(FOLDER, REPO);
    expect(dispatches().pop()?.input.prompt).toMatch(/without showing the user a slide/);
    expect((docs.docs[KEY] as any).nudges).toBe(1);
  });

  it("refuses when no question is waiting", () => {
    expect(() => answer(FOLDER, REPO, "x")).toThrow(/no question waiting/);
  });

});

describe("project_planner_write_definition", () => {
  it("writes the file INTO the repo and pins the note", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "For ___?", why: "W." }, ctx);
    answer(FOLDER, REPO, "hats");
    const r = toolWriteDefinition({ section: "overview", markdown: "# Def\n- sells hats", note: "Recorded the purpose" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("apps/web/PROJECT_DEFINITION.md");
    const write = hostCalls.find((c) => c.name === "peckboard_write_file");
    expect(write?.input.path).toBe("apps/web/PROJECT_DEFINITION.md");
    const st = docs.docs[KEY] as any;
    expect(st.history[0].note).toBe("Recorded the purpose");
  });

// The definition is split: the root holds purpose/goals + a generated index,
// each section is its own file that depends on the root.
describe("split definition", () => {
  /** baseHandlers plus an in-memory repo filesystem. */
  function fsHandlers(files: Record<string, string>) {
    return {
      ...baseHandlers(docs),
      peckboard_read_file: ({ path }: any) => {
        if (path === "apps/web/.git/HEAD") return { content: "ref: refs/heads/main\n" };
        return path in files ? { content: files[path] } : { error: "file not found" };
      },
      peckboard_write_file: ({ path, content }: any) => {
        files[path] = content;
        return { ok: true };
      },
    };
  }
  const ROOT = "apps/web/PROJECT_DEFINITION.md";
  const TECH = "apps/web/project-definition/technology.md";

  it("writes a section into its own file with a depends-on header, and indexes it in the root", () => {
    const files: Record<string, string> = {};
    setHandlers(fsHandlers(files));
    runningState(docs);
    toolWriteDefinition({ section: "overview", markdown: "# Hats\n\n## Purpose\nSell hats." }, ctx);
    const r = toolWriteDefinition(
      { section: "technology", markdown: "- Rust + Axum: one binary.", summary: "Rust/Axum backend" },
      ctx,
    );
    expect(r.path).toBe(TECH);
    expect(files[TECH]).toMatch(/^# Technology\n/);
    expect(files[TECH]).toContain("> Depends on: [PROJECT_DEFINITION.md](../PROJECT_DEFINITION.md)");
    expect(files[TECH]).toContain("- Rust + Axum: one binary.");
    expect(files[ROOT]).toContain("Sell hats.");
    expect(files[ROOT]).toContain("- [Technology](project-definition/technology.md) — Rust/Axum backend");
    expect(files[ROOT]).toContain("- Flows — not written yet");
    // Re-writing the overview keeps the section summaries.
    toolWriteDefinition({ section: "overview", markdown: "# Hats\n\n## Purpose\nSell hats online." }, ctx);
    expect(files[ROOT]).toContain("Sell hats online.");
    expect(files[ROOT]).toContain("— Rust/Axum backend");
    // read_section returns exactly one file.
    expect(toolReadSection({ section: "technology" }, ctx).content).toBe(files[TECH]);
    expect(toolReadSection({ section: "flows" }, ctx).content).toBe(null);
    expect(toolWriteDefinition({ markdown: "x" }, ctx).error).toMatch(/section is required/);
  });

  it("the record turn carries the index and only the slide's section", () => {
    const files: Record<string, string> = {};
    setHandlers(fsHandlers(files));
    runningState(docs);
    toolWriteDefinition({ section: "overview", markdown: "# Hats" }, ctx);
    toolWriteDefinition({ section: "technology", markdown: "- TECH-BODY", summary: "s" }, ctx);
    toolWriteDefinition({ section: "flows", markdown: "- FLOWS-BODY", summary: "s" }, ctx);
    toolAsk({ topic: "DB", section: "technology", kind: "fill", question: "DB is ___", why: "W." }, ctx);
    answer(FOLDER, REPO, "SQLite");
    const prompt = hostCalls.filter((c) => c.name === "peckboard_dispatch_capture").pop()?.input.prompt;
    expect(prompt).toContain("TECH-BODY");
    expect(prompt).not.toContain("FLOWS-BODY");
    expect(prompt).toContain("project-definition/flows.md"); // linked from the index
  });

  it("splits a legacy single-file definition on the session's first tool call, dropping nothing", () => {
    const files: Record<string, string> = {
      [ROOT]: "# Hats\n\n## Purpose\nSell hats.\n\n## Technology\n- Rust.\n\n## Branding\nRed.\n",
    };
    setHandlers(fsHandlers(files));
    start(FOLDER, REPO, "mock:happy-path");
    // start() runs in a page route, where core forbids writes: nothing is
    // written, but the kickoff already gets the split INDEX, not the bodies.
    expect(hostCalls.some((c) => c.name === "peckboard_write_file")).toBe(false);
    const kickoff = hostCalls.find((c) => c.name === "peckboard_dispatch_capture")?.input.prompt;
    expect(kickoff).toContain("(project-definition/technology.md)");
    expect(kickoff).not.toContain("- Rust.");
    expect(toolReadSection({ section: "technology" }, ctx).content).toContain("- Rust.");
    // That tool call was the first write-capable context: the split landed.
    expect(files[TECH]).toContain("- Rust.");
    expect(files[TECH]).toContain("> Depends on:");
    expect(files[ROOT]).toContain("Sell hats.");
    expect(files[ROOT]).toContain("## Branding\nRed.");
    expect(files[ROOT]).not.toContain("- Rust.");
    expect(files[ROOT]).toContain("(project-definition/technology.md)");
    const s = pageState(FOLDER, REPO);
    expect(s.definition_files.map((f: any) => f.section)).toEqual([
      "overview",
      "users-stories",
      "flows",
      "architecture",
      "technology",
      "deployment-operations",
      "open-questions",
    ]);
    expect(s.definition_files.find((f: any) => f.section === "technology").exists).toBe(true);
    expect(s.definition_files.find((f: any) => f.section === "flows").exists).toBe(false);
  });

  it("ask refuses a slide without a section", () => {
    runningState(docs);
    const r = toolAsk({ topic: "T", kind: "fill", question: "Q ___", why: "W." }, ctx);
    expect(r.error).toMatch(/section is required/);
  });
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

// Core's boot sweep deletes temp sessions with no tab, so a server restart
// mid-interview takes the planner session with it. The plugin replaces it.
describe("session recovery", () => {
  const NEW = "s2";
  /** The old session is gone: absent from the listing, not-found on dispatch. */
  function goneHandlers(extra: Record<string, (input: any) => unknown> = {}) {
    return {
      ...baseHandlers(docs),
      peckboard_create_session: () => ({ session: { id: NEW } }),
      peckboard_list_sessions_brief: () => ({ sessions: [{ session_id: NEW }] }),
      peckboard_dispatch_capture: ({ session_id }: any) =>
        session_id === SESSION ? { error: "session not found" } : { ok: true },
      ...extra,
    };
  }
  const dispatches = () => hostCalls.filter((c) => c.name === "peckboard_dispatch_capture");

  it("thinking mid-record: a new session gets the record prompt with the pending answer", () => {
    runningState(docs);
    Object.assign(docs.docs[KEY] as any, {
      stage: "record",
      history: [{ topic: "T", question: "The project is for ___", answer: "selling hats", note: null }],
      last_seq: 9,
      turn_open: 1,
      turn_started: true,
      wipe_seq: 5,
      wipe_at: Date.now(),
      nudges: 1,
    });
    setHandlers(goneHandlers());
    const s = pageState(FOLDER, REPO);
    expect(s.status).toBe("thinking");
    const st = docs.docs[KEY] as any;
    expect(st.session_id).toBe(NEW);
    expect(st.stage).toBe("record");
    expect([st.last_seq, st.turn_open, st.turn_started, st.wipe_seq, st.wipe_at, st.nudges]).toEqual([
      0,
      0,
      false,
      null,
      null,
      0,
    ]);
    expect(docs.docs[`sessions/${NEW}`]).toEqual({ folder_id: FOLDER, repo: REPO });
    expect(docs.docs[`sessions/${SESSION}`]).toBeUndefined();
    const create = hostCalls.find((c) => c.name === "peckboard_create_session");
    expect(create?.input).toMatchObject({ is_temp: true, is_expert: true, model: "m" });
    expect(dispatches().map((c) => c.input.session_id)).toEqual([NEW]);
    expect(dispatches()[0].input.prompt).toContain("selling hats");
    // The new session drives the interview; the old one no longer does.
    expect(toolWriteDefinition({ section: "overview", markdown: "# Def" }, { folderId: FOLDER, sessionId: NEW }).ok).toBe(true);
  });

  it("thinking before the first slide: the new session gets the kickoff", () => {
    runningState(docs);
    setHandlers(goneHandlers());
    pageState(FOLDER, REPO);
    expect((docs.docs[KEY] as any).session_id).toBe(NEW);
    expect(dispatches()[0].input.prompt).toMatch(/Begin the interview now/);
  });

  it("waiting: the slide stays and the answer goes to the new session", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    setHandlers(goneHandlers());
    const s = pageState(FOLDER, REPO);
    expect(s.status).toBe("waiting");
    expect(s.slide.question).toBe("The project is for ___");
    expect((docs.docs[KEY] as any).session_id).toBe(NEW);
    expect(dispatches()).toEqual([]); // nothing to say until the user answers

    setHandlers(goneHandlers());
    answer(FOLDER, REPO, "selling hats");
    expect(dispatches().map((c) => c.input.session_id)).toEqual([NEW]);
    expect(dispatches()[0].input.prompt).toContain("selling hats");
  });

  it("waiting: an answer sent before any poll noticed still reaches a new session", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", section: "overview", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    setHandlers(goneHandlers());
    expect(answer(FOLDER, REPO, "selling hats").ok).toBe(true);
    const st = docs.docs[KEY] as any;
    expect(st.session_id).toBe(NEW);
    expect(st.stage).toBe("record");
    expect(dispatches().map((c) => c.input.session_id)).toEqual([SESSION, NEW]);
    expect(dispatches()[1].input.prompt).toContain("selling hats");
  });

  it("fails with a clear error when no replacement can be created, without retrying", () => {
    runningState(docs);
    setHandlers(goneHandlers({ peckboard_create_session: () => ({ error: "model unavailable" }) }));
    const s = pageState(FOLDER, REPO);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/replacement could not be created: model unavailable/);
    setHandlers(goneHandlers());
    pageState(FOLDER, REPO);
    expect(hostCalls.some((c) => c.name === "peckboard_create_session")).toBe(false);
  });

  it("stops replacing a session that keeps vanishing", () => {
    runningState(docs);
    setHandlers(goneHandlers({ peckboard_list_sessions_brief: () => ({ sessions: [] }) }));
    for (let i = 0; i < 5; i++) pageState(FOLDER, REPO);
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("failed");
    expect(st.error).toMatch(/disappeared/);
  });
});

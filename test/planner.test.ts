import { beforeEach, describe, expect, it } from "vitest";
import { docStore, hostCalls, setHandlers } from "./fakeHost";
import {
  answer,
  emptyState,
  pageState,
  reset,
  start,
  toolAsk,
  toolFinish,
  toolQueue,
  toolWriteDefinition,
} from "../src/planner";

const FOLDER = "f1";
const SESSION = "s1";
const KEY = `planner/${FOLDER}`;

/** Handlers for a healthy running interview. */
function baseHandlers(docs: ReturnType<typeof docStore>) {
  return {
    ...docs.handlers,
    peckboard_caller_scope: () => ({ folder_id: FOLDER, authority: true }),
    peckboard_create_session: () => ({ session: { id: SESSION } }),
    peckboard_dispatch_capture: () => ({}),
    peckboard_read_file: () => ({ error: "file not found" }),
    peckboard_write_file: () => ({ ok: true }),
    peckboard_session_events: () => ({ events: [], latest_seq: null }),
    peckboard_list_sessions_brief: () => ({ sessions: [{ session_id: SESSION }] }),
    peckboard_list_models: () => ({
      models: [{ id: "mock:happy-path", display_name: "Mock", provider: "mock", account_id: null, thinking: true, tier: 1 }],
    }),
  };
}

const ctx = { folder_id: FOLDER, session_id: SESSION };

function runningState(docs: ReturnType<typeof docStore>) {
  docs.docs[KEY] = { ...emptyState(), status: "thinking", session_id: SESSION, model: "m" };
}

let docs: ReturnType<typeof docStore>;
beforeEach(() => {
  docs = docStore();
  setHandlers(baseHandlers(docs));
});

describe("start", () => {
  it("creates a temp session with the contract and dispatches the kickoff", () => {
    start(FOLDER, "mock:happy-path");
    const create = hostCalls.find((c) => c.name === "peckboard_create_session");
    expect(create?.input.is_temp).toBe(true);
    expect(create?.input.system_prompt).toContain("project_planner_ask");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.session_id).toBe(SESSION);
    expect(dispatch?.input.prompt).toMatch(/seed the skeleton/);
    expect((docs.docs[KEY] as any).status).toBe("thinking");
  });

  it("embeds an existing definition in the kickoff", () => {
    setHandlers({
      ...baseHandlers(docs),
      peckboard_read_file: () => ({ content: "# Existing def" }),
    });
    start(FOLDER, "mock:happy-path");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain("# Existing def");
    expect(dispatch?.input.prompt).toMatch(/Continue from it/);
  });

  it("refuses while an interview is already running", () => {
    runningState(docs);
    expect(() => start(FOLDER, "m")).toThrow(/already running/);
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
    expect(st.slide.options).toHaveLength(2);
  });

  it("rejects a slide without justification for the problem", () => {
    const r = toolAsk({ topic: "T", kind: "fill", question: "Name ___?", why: "" }, ctx);
    expect(r.error).toMatch(/why is required/);
  });

  it("rejects choice slides with unjustified or too few options", () => {
    const few = toolAsk(
      { topic: "T", kind: "choice", question: "Q?", why: "W.", options: [{ label: "A", detail: "d" }] },
      ctx,
    );
    expect(few.error).toMatch(/2 to 5 options/);
    const bare = toolAsk(
      {
        topic: "T",
        kind: "choice",
        question: "Q?",
        why: "W.",
        options: [
          { label: "A", detail: "" },
          { label: "B", detail: "justified" },
        ],
      },
      ctx,
    );
    expect(bare.error).toMatch(/option 'A' has no detail/);
  });

  it("only accepts the folder's own planner session", () => {
    expect(() => toolAsk({ topic: "T", kind: "fill", question: "Q ___", why: "W." }, { folder_id: FOLDER, session_id: "intruder" })).toThrow(
      /reserved for the Project Planner/,
    );
  });
});

describe("answer", () => {
  it("appends history and dispatches the answer prompt", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", kind: "fill", question: "The project is for ___", why: "W." }, ctx);
    setHandlers(baseHandlers(docs)); // clear the call log, keep the store
    answer(FOLDER, "selling hats");
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("thinking");
    expect(st.history).toHaveLength(1);
    expect(st.history[0].answer).toBe("selling hats");
    const dispatch = hostCalls.find((c) => c.name === "peckboard_dispatch_capture");
    expect(dispatch?.input.prompt).toContain("selling hats");
    expect(dispatch?.input.prompt).toContain("The project is for ___");
  });

  it("refuses when no question is waiting", () => {
    expect(() => answer(FOLDER, "x")).toThrow(/no question waiting/);
  });
});

describe("project_planner_write_definition", () => {
  it("writes the file and pins the note to the answered slide", () => {
    runningState(docs);
    toolAsk({ topic: "Purpose", kind: "fill", question: "For ___?", why: "W." }, ctx);
    answer(FOLDER, "hats");
    const r = toolWriteDefinition({ markdown: "# Def\n- sells hats", note: "Recorded the purpose" }, ctx);
    expect(r.ok).toBe(true);
    const write = hostCalls.find((c) => c.name === "peckboard_write_file");
    expect(write?.input.path).toBe("PROJECT_DEFINITION.md");
    expect(write?.input.content).toContain("sells hats");
    const st = docs.docs[KEY] as any;
    expect(st.history[0].note).toBe("Recorded the purpose");
  });

  it("rejects an empty definition", () => {
    runningState(docs);
    expect(toolWriteDefinition({ markdown: "  " }, ctx).error).toMatch(/markdown is required/);
  });
});

describe("project_planner_queue", () => {
  it("adds, dedupes, and removes pending questions", () => {
    runningState(docs);
    toolQueue({ add: ["Which DB?", "Which DB?", "How deployed?"] }, ctx);
    let st = docs.docs[KEY] as any;
    expect(st.pending).toEqual(["Which DB?", "How deployed?"]);
    toolQueue({ remove: ["Which DB?"] }, ctx);
    st = docs.docs[KEY] as any;
    expect(st.pending).toEqual(["How deployed?"]);
  });
});

describe("project_planner_finish", () => {
  it("ends the interview with a summary", () => {
    runningState(docs);
    const r = toolFinish({ summary: "Everything is pinned down." }, ctx);
    expect(r.ok).toBe(true);
    const st = docs.docs[KEY] as any;
    expect(st.status).toBe("done");
    expect(st.summary).toBe("Everything is pinned down.");
  });
});

describe("pageState settling", () => {
  it("nudges a run that ended without asking, then fails it", () => {
    runningState(docs);
    setHandlers({
      ...baseHandlers(docs),
      peckboard_session_events: () => ({
        events: [{ seq: 1, kind: "agent-end", name: null }],
        latest_seq: 1,
      }),
    });
    let s = pageState(FOLDER);
    expect(s.status).toBe("thinking"); // nudged, not failed
    expect(hostCalls.some((c) => c.name === "peckboard_dispatch_capture")).toBe(true);
    // Keep ending without asking → eventually failed.
    pageState(FOLDER);
    s = pageState(FOLDER);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/without showing a slide/);
  });

  it("fails when the planner session vanished", () => {
    runningState(docs);
    setHandlers({
      ...baseHandlers(docs),
      peckboard_list_sessions_brief: () => ({ sessions: [] }),
    });
    const s = pageState(FOLDER);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/gone/);
  });

  it("reset clears the interview but not the definition file", () => {
    runningState(docs);
    reset(FOLDER);
    expect((docs.docs[KEY] as any).status).toBe("idle");
    expect(hostCalls.some((c) => c.name === "peckboard_write_file")).toBe(false);
  });
});

// The interview state machine. One interview per folder, stored in the plugin
// document store; the planner session reports back through the MCP tools at
// the bottom (session events are payload-slim, so tools are the only channel).

import {
  callerScope,
  createSession,
  dispatchCapture,
  listModels,
  readFileOrNull,
  sessionEvents,
  sessionExists,
  setSessionSystemPrompt,
  storeGet,
  storePut,
  writeFile,
} from "./host";
import { DEFINITION_FILE, SYSTEM_PROMPT, answerPrompt, kickoffPrompt, stalledPrompt } from "./prompt";
import { errMsg } from "./verdict";

const COLLECTION = "planner";
const EVENTS_PAGE_LIMIT = 200;
/** Queue and history caps: the queue is re-shown to the agent every turn, so
 * an unbounded one would grow the very context the contract keeps small. */
const MAX_PENDING = 30;
const MAX_HISTORY = 200;
/** How often a stalled run (ended without asking) is re-nudged before the
 * interview is marked failed. */
const MAX_NUDGES = 2;
/** Definition preview cap for the page (the file itself is not capped). */
const MAX_DEFINITION_PREVIEW = 100_000;

export interface SlideOption {
  label: string;
  detail: string;
}

export interface Slide {
  slide_no: number;
  topic: string;
  kind: "choice" | "fill";
  question: string;
  why: string;
  options: SlideOption[];
  multi: boolean;
  blank_hint: string | null;
  diagram: string | null;
}

export interface HistoryEntry {
  topic: string;
  question: string;
  answer: string;
  note: string | null;
}

export type PlannerStatus = "idle" | "thinking" | "waiting" | "done" | "failed";

export interface PlannerState {
  status: PlannerStatus;
  session_id: string | null;
  model: string | null;
  slide: Slide | null;
  history: HistoryEntry[];
  pending: string[];
  summary: string | null;
  error: string | null;
  last_seq: number;
  nudges: number;
  started_at: string | null;
  /** Last definition-change line reported by the agent. */
  last_note: string | null;
}

export function emptyState(): PlannerState {
  return {
    status: "idle",
    session_id: null,
    model: null,
    slide: null,
    history: [],
    pending: [],
    summary: null,
    error: null,
    last_seq: 0,
    nudges: 0,
    started_at: null,
    last_note: null,
  };
}

export function loadState(folderId: string): PlannerState {
  const raw = storeGet(COLLECTION, folderId);
  return raw ? { ...emptyState(), ...raw } : emptyState();
}

function saveState(folderId: string, state: PlannerState): void {
  storePut(COLLECTION, folderId, state);
}

/** The folder this authed page request is scoped to, or a user-facing error. */
export function requireFolder(): string {
  const scope = callerScope();
  if (!scope.folder_id) {
    throw new Error(
      "this page could not be tied to a folder — open Project Planner from the Folders page, " +
        "or from a project or session inside the folder",
    );
  }
  return scope.folder_id;
}

// ── Page-facing operations (authed routes) ──────────────────────────────────

/** What the slideshow renders. Also settles a stalled/vanished run. */
export function pageState(folderId: string): any {
  let state = loadState(folderId);
  state = settleRun(folderId, state);
  const definition = readFileOrNull(DEFINITION_FILE);
  return {
    status: state.status,
    slide: state.slide,
    history: state.history.map((h) => ({ topic: h.topic, note: h.note })),
    answered: state.history.length,
    pending_count: state.pending.length,
    summary: state.summary,
    error: state.error,
    last_note: state.last_note,
    model: state.model,
    definition_exists: definition !== null,
    definition:
      definition === null
        ? null
        : definition.length > MAX_DEFINITION_PREVIEW
          ? definition.slice(0, MAX_DEFINITION_PREVIEW)
          : definition,
    definition_file: DEFINITION_FILE,
    // Model picker for the start slide; tiers ascend in capability.
    models:
      state.status === "idle"
        ? listModels().map((m) => ({ id: m.id, display_name: m.display_name, tier: m.tier }))
        : [],
  };
}

/** Start (or restart) the interview: temp session + kickoff dispatch. */
export function start(folderId: string, modelId: string): any {
  if (typeof modelId !== "string" || !modelId) {
    throw new Error("pick a model first");
  }
  const prior = loadState(folderId);
  if (prior.status === "thinking" || prior.status === "waiting") {
    throw new Error("an interview is already running for this folder — reset it first");
  }

  const definition = readFileOrNull(DEFINITION_FILE);
  let sessionId: string;
  try {
    sessionId = createSession({
      name: "Project Planner interview",
      model: modelId,
      is_temp: true,
      system_prompt: SYSTEM_PROMPT,
    });
  } catch (e) {
    throw new Error(`could not create the planner session: ${errMsg(e)}`);
  }

  const state: PlannerState = {
    ...emptyState(),
    status: "thinking",
    session_id: sessionId,
    model: modelId,
    // A previous run's queue survives reset-less restarts via the definition
    // file only; the in-store queue restarts clean with the interview.
    pending: [],
    started_at: new Date().toISOString(),
  };
  saveState(folderId, state);

  try {
    dispatchCapture(sessionId, kickoffPrompt(definition, state.pending));
  } catch (e) {
    saveState(folderId, {
      ...state,
      status: "failed",
      error: `the planner session was created but the first prompt could not be dispatched: ${errMsg(e)}`,
    });
    throw new Error(`could not start the interview: ${errMsg(e)}`);
  }
  return { ok: true };
}

/** The user answered the current slide. */
export function answer(folderId: string, answerText: string): any {
  const state = loadState(folderId);
  if (state.status !== "waiting" || !state.slide || !state.session_id) {
    throw new Error("there is no question waiting for an answer");
  }
  const text = (answerText ?? "").toString().trim();
  if (!text) {
    throw new Error("the answer is empty");
  }

  const asked = state.slide;
  const next: PlannerState = {
    ...state,
    status: "thinking",
    slide: null,
    nudges: 0,
    history: [
      ...state.history,
      { topic: asked.topic, question: asked.question, answer: text, note: null },
    ].slice(-MAX_HISTORY),
  };
  saveState(folderId, next);

  try {
    dispatchCapture(
      state.session_id,
      answerPrompt({
        question: asked.question,
        answer: text,
        definition: readFileOrNull(DEFINITION_FILE),
        pending: next.pending,
      }),
    );
  } catch (e) {
    saveState(folderId, {
      ...next,
      status: "failed",
      error: `the answer could not be dispatched to the planner session: ${errMsg(e)}`,
    });
    throw new Error(`could not send the answer: ${errMsg(e)}`);
  }
  return { ok: true };
}

/** Drop the interview state (the definition file stays). */
export function reset(folderId: string): any {
  saveState(folderId, emptyState());
  return { ok: true };
}

/** While "thinking", watch the slim event tail: a run that ended without
 * asking gets nudged (the model forgot the tool), then fails; a session that
 * vanished fails immediately. Tool calls flip the status before this runs, so
 * a healthy run never trips it. */
function settleRun(folderId: string, state: PlannerState): PlannerState {
  if (state.status !== "thinking" || !state.session_id) {
    return state;
  }
  let lastSeq = state.last_seq;
  let ended = false;
  try {
    for (;;) {
      const page = sessionEvents(state.session_id, lastSeq, EVENTS_PAGE_LIMIT);
      if (!page.events.length) break;
      for (const e of page.events) {
        if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
        if (e.kind === "agent-end") ended = true;
      }
      if (page.events.length < EVENTS_PAGE_LIMIT) break;
    }
  } catch {
    return state; // transient read failure — try again on the next poll
  }

  let next = { ...state, last_seq: lastSeq };
  // Re-read: an ask/write tool call may have landed while we polled.
  const fresh = loadState(folderId);
  if (fresh.status !== "thinking") {
    return fresh;
  }

  if (ended) {
    if (next.nudges < MAX_NUDGES) {
      next = { ...next, nudges: next.nudges + 1 };
      try {
        dispatchCapture(state.session_id, stalledPrompt());
      } catch (e) {
        next = { ...next, status: "failed", error: `the planner session stopped responding: ${errMsg(e)}` };
      }
    } else {
      next = {
        ...next,
        status: "failed",
        error: "the planner session kept ending its runs without showing a slide",
      };
    }
  } else if (!sessionExists(state.session_id)) {
    next = {
      ...next,
      status: "failed",
      error: "the planner session is gone (closed, cleared, or crashed) — reset and start again",
    };
  }

  if (JSON.stringify(next) !== JSON.stringify(state)) {
    saveState(folderId, next);
  }
  return next;
}

// ── Agent-facing tools (mcp.tool.invoke) ────────────────────────────────────

/** Guard: tools only accept calls from the folder's own planner session, so a
 * stray agent in the same folder can't hijack the slideshow.
 *
 * The invoke context arrives CAMEL-CASE from core (`routes/mcp.rs` →
 * `dispatch_tool_call` builds `{sessionId, projectId, cardId, folderId}`);
 * the snake_case forms are accepted too in case that shape ever changes.
 * Reading the wrong casing here is exactly the 0.1.0 bug that made every
 * tool call fail with "no folder scope" and the interview never wait. */
function plannerStateFor(context: any): { folderId: string; state: PlannerState } {
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) {
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
  const folderId = pick(context?.folderId, context?.folder_id);
  if (!folderId) {
    throw new Error("this tool only works from a session inside a workspace folder");
  }
  const state = loadState(folderId);
  const caller = pick(context?.sessionId, context?.session_id);
  if (!state.session_id || caller !== state.session_id) {
    throw new Error(
      "this tool is reserved for the Project Planner interview session — start an interview " +
        "from the Project Planner page",
    );
  }
  return { folderId, state };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** project_planner_ask — validate and publish the next slide. */
export function toolAsk(args: any, context: any): any {
  const { folderId, state } = plannerStateFor(context);
  // One slide at a time IS the product: a second ask before the user answered
  // would silently replace the showing slide and the interview would stop
  // waiting for answers. Refuse so the model ends its turn instead.
  if (state.status === "waiting") {
    return {
      error:
        "a slide is already showing and unanswered — do not ask again; end your turn and wait " +
        "for the user's answer to arrive as the next message",
    };
  }
  const kind = asString(args?.kind);
  const question = asString(args?.question);
  const why = asString(args?.why);
  const topic = asString(args?.topic) || "Project";
  if (kind !== "choice" && kind !== "fill") {
    return { error: "kind must be 'choice' or 'fill'" };
  }
  if (!question) return { error: "question is required" };
  if (!why) {
    return { error: "why is required — one or two sentences justifying the problem this decides" };
  }
  let options: SlideOption[] = [];
  if (kind === "choice") {
    const raw = Array.isArray(args?.options) ? args.options : [];
    options = raw
      .map((o: any) => ({ label: asString(o?.label), detail: asString(o?.detail) }))
      .filter((o: SlideOption) => o.label);
    if (options.length < 2 || options.length > 5) {
      return { error: "a choice slide needs 2 to 5 options" };
    }
    const unjustified = options.find((o) => !o.detail);
    if (unjustified) {
      return {
        error: `option '${unjustified.label}' has no detail — every option needs its one-sentence justification`,
      };
    }
  }
  const slide: Slide = {
    slide_no: state.history.length + 1,
    topic,
    kind,
    question,
    why,
    options,
    multi: args?.multi === true,
    blank_hint: asString(args?.blank_hint) || null,
    diagram: asString(args?.diagram) || null,
  };
  storePut(COLLECTION, folderId, { ...state, status: "waiting", slide, nudges: 0 });
  return {
    ok: true,
    note: "The slide is showing. End your turn now — the user's answer arrives as the next message.",
  };
}

/** project_planner_queue — add/remove pending follow-ups. */
export function toolQueue(args: any, context: any): any {
  const { folderId, state } = plannerStateFor(context);
  const add = (Array.isArray(args?.add) ? args.add : []).map(asString).filter(Boolean);
  const remove = new Set((Array.isArray(args?.remove) ? args.remove : []).map(asString));
  let pending = state.pending.filter((q) => !remove.has(q));
  for (const q of add) {
    if (!pending.includes(q)) pending.push(q);
  }
  const dropped = Math.max(0, pending.length - MAX_PENDING);
  pending = pending.slice(0, MAX_PENDING);
  storePut(COLLECTION, folderId, { ...state, pending });
  return {
    ok: true,
    pending,
    ...(dropped ? { note: `queue is capped at ${MAX_PENDING}; ${dropped} entries were dropped` } : {}),
  };
}

/** project_planner_write_definition — persist the definition file. */
export function toolWriteDefinition(args: any, context: any): any {
  const { folderId, state } = plannerStateFor(context);
  const markdown = typeof args?.markdown === "string" ? args.markdown : "";
  if (!markdown.trim()) {
    return { error: "markdown is required — the complete new definition file content" };
  }
  writeFile(DEFINITION_FILE, markdown.endsWith("\n") ? markdown : markdown + "\n");
  const note = asString(args?.note) || null;
  const history = state.history.slice();
  // The note describes what the just-answered question changed — pin it there.
  if (note && history.length && history[history.length - 1].note === null) {
    history[history.length - 1] = { ...history[history.length - 1], note };
  }
  storePut(COLLECTION, folderId, { ...state, history, last_note: note ?? state.last_note });
  return { ok: true, path: DEFINITION_FILE };
}

/** project_planner_finish — completion slide. */
export function toolFinish(args: any, context: any): any {
  const { folderId, state } = plannerStateFor(context);
  const summary = asString(args?.summary);
  if (!summary) {
    return { error: "summary is required — two or three sentences on what the definition pins down" };
  }
  storePut(COLLECTION, folderId, { ...state, status: "done", slide: null, summary });
  return { ok: true, note: "The interview is complete; the user sees your summary." };
}

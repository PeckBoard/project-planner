// The interview state machine. One interview per GIT REPO (a folder can hold
// several repos — the interview, its definition file, and its reset are all
// repo-scoped). State lives in the plugin document store; the planner session
// reports back through the MCP tools at the bottom (session events are
// payload-slim, so tools are the only channel).

import {
  callerScope,
  createSession,
  dispatchCapture,
  hostCall,
  listModels,
  readFileOrNull,
  sessionEvents,
  sessionExists,
  storeGet,
  storePut,
  writeFile,
} from "./host";
import { DEFINITION_FILE, SYSTEM_PROMPT, answerPrompt, kickoffPrompt, stalledPrompt } from "./prompt";
import { errMsg } from "./verdict";

const COLLECTION = "planner";
/** sessionId → {folder_id, repo}: how a tool call finds ITS interview. */
const SESSIONS = "sessions";
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
/** Repo-discovery caps: directories probed for a `.git/HEAD`. */
const MAX_PROBE_DIRS = 400;
const MAX_PROBE_DEPTH = 6;

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
  /** The answer the repo's existing code supports, when the agent found
   * one — the slide offers one-click confirmation and correction. */
  proposed_answer: string | null;
  /** One sentence naming where the code shows it; required with a proposal
   * so the user can judge the conclusion. */
  evidence: string | null;
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

// ── Repo scoping ────────────────────────────────────────────────────────────

/** Folder-relative repo path; `"."` = the folder root itself is the repo. */
export function normalizeRepo(raw: unknown): string {
  const r = (typeof raw === "string" ? raw : "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return r === "" ? "." : r;
}

/** Where the repo's definition file lives — INSIDE the repo, so it is
 * committed with the code it describes. */
export function definitionPath(repo: string): string {
  return repo === "." ? DEFINITION_FILE : `${repo}/${DEFINITION_FILE}`;
}

function stateKey(folderId: string, repo: string): string {
  return `${folderId}|${repo}`;
}

/** Branch behind a HEAD file (`ref: refs/heads/x` → `x`; detached → id8). */
function headBranch(head: string): string {
  const raw = head.trim();
  const m = raw.match(/^ref: refs\/heads\/(.+)$/);
  return m ? m[1] : raw.slice(0, 8);
}

/** Is `repo` actually a git repo in this folder? Returns its HEAD content. */
function probeRepo(repo: string): string | null {
  if (repo.includes("..")) return null; // the jail rejects it anyway
  return readFileOrNull(repo === "." ? ".git/HEAD" : `${repo}/.git/HEAD`);
}

export interface RepoInfo {
  path: string;
  name: string;
  branch: string;
}

/** Find the git repos in the caller's folder: unique directory prefixes of
 * the jailed file walk, probed for `.git/HEAD` (the walk itself never
 * descends into `.git`, so the probe is a direct read). Repos nested inside
 * an already-found repo's tree are skipped, mirroring core's scan. */
export function discoverRepos(): RepoInfo[] {
  const listed = hostCall("peckboard_list_project_files", {});
  const files: Array<{ path: string }> = listed?.files ?? [];
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop();
    for (let d = 1; d <= Math.min(parts.length, MAX_PROBE_DEPTH); d++) {
      dirs.add(parts.slice(0, d).join("/"));
      if (dirs.size > MAX_PROBE_DIRS) break;
    }
    if (dirs.size > MAX_PROBE_DIRS) break;
  }
  // Shallow-first so a parent repo claims its subtree before we probe it.
  const ordered = [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const repos: RepoInfo[] = [];
  for (const dir of ordered) {
    if (repos.some((r) => r.path !== "." && (dir === r.path || dir.startsWith(r.path + "/")))) {
      continue; // inside an already-found repo
    }
    const head = probeRepo(dir === "" ? "." : dir);
    if (head === null) continue;
    const path = dir === "" ? "." : dir;
    repos.push({
      path,
      name: path === "." ? "(folder root)" : path.split("/").pop() || path,
      branch: headBranch(head),
    });
    if (path === ".") break; // the folder root repo owns the whole tree
  }
  return repos;
}

export function loadState(folderId: string, repo: string): PlannerState {
  const raw = storeGet(COLLECTION, stateKey(folderId, repo));
  return raw ? { ...emptyState(), ...raw } : emptyState();
}

function saveState(folderId: string, repo: string, state: PlannerState): void {
  storePut(COLLECTION, stateKey(folderId, repo), state);
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

/** The repo picker's data: every repo with its interview status. */
export function repoList(folderId: string): any {
  const repos = discoverRepos().map((r) => {
    const st = loadState(folderId, r.path);
    return {
      ...r,
      status: st.status,
      answered: st.history.length,
      definition_exists: readFileOrNull(definitionPath(r.path)) !== null,
    };
  });
  return { repos };
}

/** What the slideshow renders for one repo. Also settles a stalled run. */
export function pageState(folderId: string, repoRaw: unknown): any {
  const repo = normalizeRepo(repoRaw);
  let state = loadState(folderId, repo);
  state = settleRun(folderId, repo, state);
  const definition = readFileOrNull(definitionPath(repo));
  return {
    repo,
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
    definition_file: definitionPath(repo),
    // Model picker for the start slide; tiers ascend in capability.
    models:
      state.status === "idle"
        ? listModels().map((m) => ({ id: m.id, display_name: m.display_name, tier: m.tier }))
        : [],
  };
}

/** Start (or restart) the interview for one repo. */
export function start(
  folderId: string,
  repoRaw: unknown,
  modelId: string,
  topicRaw?: unknown,
): any {
  const repo = normalizeRepo(repoRaw);
  if (typeof modelId !== "string" || !modelId) {
    throw new Error("pick a model first");
  }
  if (probeRepo(repo) === null) {
    throw new Error(`'${repo}' is not a git repo in this folder — pick one from the repo list`);
  }
  const prior = loadState(folderId, repo);
  if (prior.status === "thinking" || prior.status === "waiting") {
    throw new Error("an interview is already running for this repo — reset it first");
  }

  const definition = readFileOrNull(definitionPath(repo));
  let sessionId: string;
  try {
    sessionId = createSession({
      name: `Project Planner interview — ${repo === "." ? "folder root" : repo}`,
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
    started_at: new Date().toISOString(),
  };
  saveState(folderId, repo, state);
  // How toolAsk & co. find their interview: the calling session's id.
  storePut(SESSIONS, sessionId, { folder_id: folderId, repo });

  const topic = typeof topicRaw === "string" ? topicRaw.trim().slice(0, 200) : "";
  try {
    dispatchCapture(sessionId, kickoffPrompt(repo, definition, state.pending, topic || null));
  } catch (e) {
    saveState(folderId, repo, {
      ...state,
      status: "failed",
      error: `the planner session was created but the first prompt could not be dispatched: ${errMsg(e)}`,
    });
    throw new Error(`could not start the interview: ${errMsg(e)}`);
  }
  return { ok: true };
}

/** The user answered the current slide of one repo's interview. */
export function answer(folderId: string, repoRaw: unknown, answerText: string): any {
  const repo = normalizeRepo(repoRaw);
  const state = loadState(folderId, repo);
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
  saveState(folderId, repo, next);

  try {
    dispatchCapture(
      state.session_id,
      answerPrompt({
        question: asked.question,
        answer: text,
        definition: readFileOrNull(definitionPath(repo)),
        pending: next.pending,
      }),
    );
  } catch (e) {
    saveState(folderId, repo, {
      ...next,
      status: "failed",
      error: `the answer could not be dispatched to the planner session: ${errMsg(e)}`,
    });
    throw new Error(`could not send the answer: ${errMsg(e)}`);
  }
  return { ok: true };
}

/** Drop one repo's interview state (its definition file stays). */
export function reset(folderId: string, repoRaw: unknown): any {
  saveState(folderId, normalizeRepo(repoRaw), emptyState());
  return { ok: true };
}

/** While "thinking", watch the slim event tail: a run that ended without
 * asking gets nudged (the model forgot the tool), then fails; a session that
 * vanished fails immediately. Tool calls flip the status before this runs, so
 * a healthy run never trips it. */
function settleRun(folderId: string, repo: string, state: PlannerState): PlannerState {
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
  const fresh = loadState(folderId, repo);
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
    saveState(folderId, repo, next);
  }
  return next;
}

// ── Agent-facing tools (mcp.tool.invoke) ────────────────────────────────────

/** Guard: a tool call is resolved to ITS interview via the calling session's
 * id (recorded at start), so only the repo's own planner session can drive
 * its slideshow.
 *
 * The invoke context arrives CAMEL-CASE from core (`routes/mcp.rs` →
 * `dispatch_tool_call` builds `{sessionId, projectId, cardId, folderId}`);
 * the snake_case forms are accepted too in case that shape ever changes.
 * Reading the wrong casing here is exactly the 0.1.0 bug that made every
 * tool call fail with "no folder scope" and the interview never wait. */
function plannerStateFor(context: any): { folderId: string; repo: string; state: PlannerState } {
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) {
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
  const folderId = pick(context?.folderId, context?.folder_id);
  const caller = pick(context?.sessionId, context?.session_id);
  if (!folderId || !caller) {
    throw new Error("this tool only works from a session inside a workspace folder");
  }
  const mapping = storeGet(SESSIONS, caller);
  const repo = typeof mapping?.repo === "string" ? mapping.repo : null;
  if (!repo || mapping?.folder_id !== folderId) {
    throw new Error(
      "this tool is reserved for the Project Planner interview session — start an interview " +
        "from the Project Planner page",
    );
  }
  const state = loadState(folderId, repo);
  if (state.session_id !== caller) {
    throw new Error(
      "this interview was reset or restarted — this session no longer drives it",
    );
  }
  return { folderId, repo, state };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** project_planner_ask — validate and publish the next slide. */
export function toolAsk(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
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
  const proposedAnswer = asString(args?.proposed_answer) || null;
  const evidence = asString(args?.evidence) || null;
  if (proposedAnswer && !evidence) {
    return {
      error:
        "evidence is required with proposed_answer — one sentence naming where the code shows " +
        "it, so the user can judge the conclusion",
    };
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
    proposed_answer: proposedAnswer,
    evidence: proposedAnswer ? evidence : null,
  };
  saveState(folderId, repo, { ...state, status: "waiting", slide, nudges: 0 });
  return {
    ok: true,
    note: "The slide is showing. End your turn now — the user's answer arrives as the next message.",
  };
}

/** project_planner_queue — add/remove pending follow-ups. */
export function toolQueue(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
  const add = (Array.isArray(args?.add) ? args.add : []).map(asString).filter(Boolean);
  const remove = new Set((Array.isArray(args?.remove) ? args.remove : []).map(asString));
  let pending = state.pending.filter((q) => !remove.has(q));
  for (const q of add) {
    if (!pending.includes(q)) pending.push(q);
  }
  const dropped = Math.max(0, pending.length - MAX_PENDING);
  pending = pending.slice(0, MAX_PENDING);
  saveState(folderId, repo, { ...state, pending });
  return {
    ok: true,
    pending,
    ...(dropped ? { note: `queue is capped at ${MAX_PENDING}; ${dropped} entries were dropped` } : {}),
  };
}

/** project_planner_write_definition — persist the repo's definition file. */
export function toolWriteDefinition(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
  const markdown = typeof args?.markdown === "string" ? args.markdown : "";
  if (!markdown.trim()) {
    return { error: "markdown is required — the complete new definition file content" };
  }
  const path = definitionPath(repo);
  writeFile(path, markdown.endsWith("\n") ? markdown : markdown + "\n");
  const note = asString(args?.note) || null;
  const history = state.history.slice();
  // The note describes what the just-answered question changed — pin it there.
  if (note && history.length && history[history.length - 1].note === null) {
    history[history.length - 1] = { ...history[history.length - 1], note };
  }
  saveState(folderId, repo, { ...state, history, last_note: note ?? state.last_note });
  return { ok: true, path };
}

/** project_planner_finish — completion slide. */
export function toolFinish(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
  const summary = asString(args?.summary);
  if (!summary) {
    return { error: "summary is required — two or three sentences on what the definition pins down" };
  }
  saveState(folderId, repo, { ...state, status: "done", slide: null, summary });
  return { ok: true, note: "The interview is complete; the user sees your summary." };
}

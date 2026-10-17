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
  storeDelete,
  storeGet,
  storePut,
  writeFile,
} from "./host";
import {
  type BatchAnswer,
  MAX_BATCH,
  SYSTEM_PROMPT,
  askNextPrompt,
  kickoffPrompt,
  recordPrompt,
  recordStalledPrompt,
  stalledPrompt,
} from "./prompt";
import {
  OVERVIEW,
  OVERVIEW_SKELETON,
  SECTIONS,
  SECTION_IDS,
  isSection,
  isSplitRoot,
  parseRoot,
  rootFile,
  rootPath,
  sectionBody,
  sectionFile,
  sectionPath,
  sectionTitle,
  splitLegacy,
} from "./sections";
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
/** Replacement sessions created in a row without the interview publishing a
 * slide before it is failed instead — a session that is created but vanishes
 * again right away must not spin up a new one on every poll. */
const MAX_RECOVERIES = 3;
/** Per-file preview cap for the page (the files themselves are not capped). */
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
  /** Definition section the answer is recorded in (see sections.ts); null
   * on slides published before the definition was split. */
  section: string | null;
  /** Position in its batch (1-based) and the batch's size; absent on slides
   * published before batching. */
  batch_index?: number;
  batch_size?: number;
  /** The exact queue entry this slide asks, removed from the queue on
   * publish. */
  from_queue?: string | null;
  /** The answer the user gave before stepping back to this slide — the
   * page prefills it. */
  previous_answer?: string | null;
}

export interface HistoryEntry {
  topic: string;
  question: string;
  answer: string;
  section?: string | null;
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
  /** Answer-cycle phase: "record" = the record turn is out (write the answer
   * into the definition, full context); "recorded" = the write landed and the
   * turn's end triggers the wipe + fresh ask turn; null = not mid-cycle. */
  stage?: "record" | "recorded" | null;
  /** Runs open in the session log (`agent-start` seen, `agent-end` not yet)
   * and whether a run started since the last dispatch — together they tell
   * the dispatched turn's `agent-end` from a late one of an older turn. */
  turn_open: number;
  turn_started: boolean;
  /** Set by the wipe + ask dispatch: the pre-wipe log's high-water mark, held
   * until the (asynchronous) wipe is seen to have landed; `wipe_at` (ms) bounds
   * how long an ambiguous log is waited on. */
  wipe_seq: number | null;
  wipe_at: number | null;
  /** Replacement sessions created since the last published slide (see
   * recoverSession). */
  recoveries: number;
  /** The rest of the published batch, after `slide`. Absent on state saved
   * before batching. */
  upcoming?: Slide[];
  /** Answers given so far in the current batch; the record turn gets them
   * all at once. */
  batch_answers?: HistoryEntry[];
  /** The batch's already-answered slides, in order, so the user can step
   * back to one (parallel to `batch_answers`). */
  answered_slides?: Slide[];
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
    stage: null,
    turn_open: 0,
    turn_started: false,
    wipe_seq: null,
    wipe_at: null,
    recoveries: 0,
    upcoming: [],
    batch_answers: [],
    answered_slides: [],
  };
}

// ── Repo scoping ────────────────────────────────────────────────────────────

/** Folder-relative repo path; `"."` = the folder root itself is the repo. */
export function normalizeRepo(raw: unknown): string {
  const r = (typeof raw === "string" ? raw : "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return r === "" ? "." : r;
}

/** Where the repo's root definition file lives — INSIDE the repo, so it is
 * committed with the code it describes. Section files sit next to it. */
export function definitionPath(repo: string): string {
  return rootPath(repo);
}

// ── Split definition I/O ────────────────────────────────────────────────────

const MIGRATED = "migrated from the single-file definition";

/** The root index as the agent sees it — READ-ONLY, so it is safe from page
 * routes (core allows file writes only inside a tool invocation). A legacy
 * single-file definition is shown as the index it splits into; the split
 * itself lands on the planner session's next tool call (migrateLegacy). */
export function loadIndex(repo: string): string | null {
  const root = readFileOrNull(rootPath(repo));
  if (root === null || isSplitRoot(root)) return root;
  const { overview, sections } = splitLegacy(root);
  return rootFile(
    overview || OVERVIEW_SKELETON,
    SECTIONS.map((s) => ({ id: s.id, exists: s.id in sections, summary: MIGRATED })),
  );
}

/** Tool-invocation only: split a legacy single-file definition into section
 * files (nothing dropped: unrecognised headings stay in the overview).
 * Returns the root content, or null when there is no definition. */
function migrateLegacy(repo: string): string | null {
  const root = readFileOrNull(rootPath(repo));
  if (root === null || isSplitRoot(root)) return root;
  const { overview, sections } = splitLegacy(root);
  const summaries: Record<string, string> = {};
  for (const [id, body] of Object.entries(sections)) {
    writeFile(sectionPath(repo, id), sectionFile(id, body));
    summaries[id] = MIGRATED;
  }
  return writeRoot(repo, overview || OVERVIEW_SKELETON, summaries);
}

/** Regenerate the root file from its overview and the per-section summaries;
 * a section is indexed as written when its file exists. Returns the content. */
function writeRoot(repo: string, overview: string, summaries: Record<string, string>): string {
  const entries = SECTIONS.map((s) => ({
    id: s.id,
    exists: readFileOrNull(sectionPath(repo, s.id)) !== null,
    summary: summaries[s.id] ?? "",
  }));
  const content = rootFile(overview, entries);
  writeFile(rootPath(repo), content);
  return content;
}

/** Write one section (the overview goes into the root file) and refresh the
 * root index. Returns the written path. */
export function writeSection(repo: string, id: string, markdown: string, summary: string | null): string {
  const current = migrateLegacy(repo);
  const parsed = current === null ? { overview: OVERVIEW_SKELETON, summaries: {} } : parseRoot(current);
  if (id === OVERVIEW) {
    writeRoot(repo, markdown.trim(), parsed.summaries);
    return rootPath(repo);
  }
  writeFile(sectionPath(repo, id), sectionFile(id, markdown));
  const summaries = { ...parsed.summaries };
  if (summary) summaries[id] = summary.replace(/\s+/g, " ").trim();
  writeRoot(repo, parsed.overview, summaries);
  return sectionPath(repo, id);
}

/** One section's current content (`overview` → the root index). Read-only:
 * a not-yet-split legacy definition is answered from its in-memory split. */
function readSection(repo: string, id: string): string | null {
  const root = readFileOrNull(rootPath(repo));
  if (id === OVERVIEW) return loadIndex(repo);
  if (root !== null && !isSplitRoot(root)) {
    const body = splitLegacy(root).sections[id];
    return body ? sectionFile(id, body) : null;
  }
  return readFileOrNull(sectionPath(repo, id));
}

/** The record turn's prompt: every answer of the batch, the index, and ONLY
 * the sections those answers named. */
function buildRecordPrompt(
  repo: string,
  entries: Array<{ question: string; answer: string; section?: string | null }>,
  pending: string[],
): string {
  const answers: BatchAnswer[] = entries.map((e) => ({
    question: e.question,
    answer: e.answer,
    section: isSection(e.section) ? e.section : null,
  }));
  const sections: Record<string, string | null> = {};
  for (const a of answers) {
    if (a.section && a.section !== OVERVIEW && !(a.section in sections)) {
      sections[a.section] = readSection(repo, a.section);
    }
  }
  return recordPrompt({ repo, answers, sections, index: loadIndex(repo), pending });
}
function preview(content: string | null): string | null {
  return content !== null && content.length > MAX_DEFINITION_PREVIEW
    ? content.slice(0, MAX_DEFINITION_PREVIEW)
    : content;
}

/** Every definition file for the page: the root first, then each section. */
function definitionFiles(repo: string): Array<{
  section: string;
  title: string;
  path: string;
  exists: boolean;
  content: string | null;
}> {
  return SECTION_IDS.map((id) => {
    const content = readFileOrNull(sectionPath(repo, id));
    return {
      section: id,
      title: sectionTitle(id),
      path: sectionPath(repo, id),
      exists: content !== null,
      content: preview(content),
    };
  });
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
    const files = SECTION_IDS.filter((id) => readFileOrNull(sectionPath(r.path, id)) !== null).length;
    return {
      ...r,
      status: st.status,
      answered: st.history.length,
      definition_exists: files > 0,
      definition_files: files,
    };
  });
  return { repos };
}

/** What the slideshow renders for one repo. Also settles a stalled run. */
export function pageState(folderId: string, repoRaw: unknown): any {
  const repo = normalizeRepo(repoRaw);
  let state = loadState(folderId, repo);
  state = settleRun(folderId, repo, state);
  const files = definitionFiles(repo);
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
    definition_exists: files.some((f) => f.exists),
    // Root first, then every section — written or not — so the page can
    // show the whole split layout.
    definition_files: files,
    definition_file: definitionPath(repo),
    // Model picker for the start slide; tiers ascend in capability.
    models:
      state.status === "idle"
        ? listModels().map((m) => ({ id: m.id, display_name: m.display_name, tier: m.tier }))
        : [],
  };
}

/** The repo's interview session. Temp so core's boot sweep cleans up the ones
 * a restarted/reset interview left behind — which also means a server restart
 * mid-interview deletes the live one; recoverSession replaces it. */
function createPlannerSession(repo: string, modelId: string): string {
  return createSession({
    name: `Project Planner interview — ${repo === "." ? "folder root" : repo}`,
    model: modelId,
    is_temp: true,
    // Plugin-managed: core keeps expert sessions out of the user's session
    // lists, and closing a tab the user opened on it doesn't delete it.
    is_expert: true,
    expert_kind: "project-planner",
    system_prompt: SYSTEM_PROMPT,
  });
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

  const definition = loadIndex(repo);
  let sessionId: string;
  try {
    sessionId = createPlannerSession(repo, modelId);
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

/** The user answered the current slide of one repo's interview. Mid-batch
 * this only advances to the next slide; the batch's last answer dispatches
 * ONE record turn carrying every answer of the batch. */
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
  const entry: HistoryEntry = {
    topic: asked.topic,
    question: asked.question,
    answer: text,
    section: asked.section ?? null,
    note: null,
  };
  const history = [...state.history, entry].slice(-MAX_HISTORY);
  const batchAnswers = [...(state.batch_answers ?? []), entry];
  const upcoming = state.upcoming ?? [];
  if (upcoming.length) {
    // More slides in this batch: no agent run until the user is through.
    saveState(folderId, repo, {
      ...state,
      slide: upcoming[0],
      upcoming: upcoming.slice(1),
      batch_answers: batchAnswers,
      answered_slides: [...(state.answered_slides ?? []), asked],
      history,
    });
    return { ok: true };
  }

  // Consume the event tail BEFORE the record dispatch. The watchdog stops
  // reading while a slide waits, so the ask turn's own `agent-end` is still
  // unread here; left in place, the first poll after this answer (the page
  // polls right away) mistakes it for the record turn ending without a write
  // and fires a record nudge that races the answer. When the nudge reaches
  // the agent first it "records" with no answer in hand, the stage flips to
  // recorded, and the context wipe then kills the turn still holding the
  // real answer — the interview re-asks the same question forever.
  let lastSeq = state.last_seq;
  let turn = { open: state.turn_open, started: state.turn_started };
  try {
    ({ lastSeq, turn } = readEventTail(state.session_id, state.last_seq, turn));
  } catch {
    // Unreadable tail: keep the old mark; settleRun retries on the next poll.
  }

  const next: PlannerState = {
    ...state,
    status: "thinking",
    slide: null,
    upcoming: [],
    batch_answers: batchAnswers,
    answered_slides: [],
    nudges: 0,
    last_seq: lastSeq,
    // A new dispatch: nothing has started for it yet. Runs still open (the
    // user answered before the ask turn wrapped up) stay counted, so their
    // late `agent-end` is not taken for the record turn's.
    turn_open: turn.open,
    turn_started: false,
    // The slide came from a tool call of the post-wipe ask turn, so any wipe
    // has landed by now and the drain above read the fresh log.
    wipe_seq: null,
    wipe_at: null,
    // Phase 1 of the answer cycle: the RECORD turn runs with full context so
    // the model still remembers asking the questions (and any code check
    // behind a proposed answer) while it folds the answers into the
    // definition. The context wipe happens between turns, when settleRun
    // dispatches the fresh ASK turn.
    stage: "record",
    history,
  };
  saveState(folderId, repo, next);

  try {
    dispatchCapture(state.session_id, buildRecordPrompt(repo, batchAnswers, next.pending));
  } catch (e) {
    if (isSessionGone(e)) {
      // The session vanished while the slide waited (e.g. a server restart's
      // temp-session sweep): a replacement picks up the record turn.
      const recovered = recoverSession(folderId, repo, next);
      if (recovered.status === "failed") {
        throw new Error(`could not send the answer: ${recovered.error}`);
      }
      return { ok: true };
    }
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

/** Step back to the previous slide of the current batch: its answer is
 * withdrawn (and offered as the prefill) and the slide showing now returns to
 * the front of the batch. Nothing reaches the agent — the batch is still
 * only recorded once its last slide is answered. */
export function back(folderId: string, repoRaw: unknown): any {
  const repo = normalizeRepo(repoRaw);
  const state = loadState(folderId, repo);
  const answered = state.answered_slides ?? [];
  const answers = state.batch_answers ?? [];
  if (state.status !== "waiting" || !state.slide || !answered.length || !answers.length) {
    throw new Error("there is no earlier question in this batch to go back to");
  }
  const prev = answered[answered.length - 1];
  const withdrawn = answers[answers.length - 1];
  saveState(folderId, repo, {
    ...state,
    slide: { ...prev, previous_answer: withdrawn.answer },
    upcoming: [{ ...state.slide, previous_answer: null }, ...(state.upcoming ?? [])],
    answered_slides: answered.slice(0, -1),
    batch_answers: answers.slice(0, -1),
    // The withdrawn answer was appended last; drop exactly that entry.
    history: state.history.length ? state.history.slice(0, -1) : state.history,
  });
  return { ok: true };
}

/** A host call failed because the session row no longer exists. */
function isSessionGone(e: unknown): boolean {
  return /session not found/i.test(errMsg(e));
}

/** Replace a vanished planner session and resume where the interview stood.
 * Core's boot sweep deletes temp sessions without a tab, so a server restart
 * mid-interview takes the session with it. Nothing is lost by that: the
 * session's context is wiped after every answer anyway, and everything durable
 * lives in the definition file, the queue, and this state. A waiting slide
 * stays up and only the session is swapped (the answer goes to the new one);
 * a thinking run re-dispatches the prompt for its stage. Saves and returns
 * the new state — `failed` when no replacement could be brought up. */
function recoverSession(folderId: string, repo: string, state: PlannerState): PlannerState {
  const fail = (error: string, base: PlannerState = state): PlannerState => {
    const failed: PlannerState = { ...base, status: "failed", error };
    saveState(folderId, repo, failed);
    return failed;
  };
  const recoveries = state.recoveries ?? 0;
  if (recoveries >= MAX_RECOVERIES) {
    return fail(
      `the planner session disappeared ${recoveries + 1} times in a row and could not be ` +
        "replaced for good — reset and start again",
    );
  }
  if (!state.model) {
    return fail("the planner session is gone and no model is on record to replace it — reset and start again");
  }
  let sessionId: string;
  try {
    sessionId = createPlannerSession(repo, state.model);
  } catch (e) {
    return fail(
      `the planner session is gone and a replacement could not be created: ${errMsg(e)} — ` +
        "reset and start again",
    );
  }
  storePut(SESSIONS, sessionId, { folder_id: folderId, repo });
  if (state.session_id && state.session_id !== sessionId) {
    try {
      storeDelete(SESSIONS, state.session_id);
    } catch {
      // A stale mapping is harmless: plannerStateFor checks state.session_id.
    }
  }
  // A fresh session has a fresh log: every watchdog mark starts over.
  let next: PlannerState = {
    ...state,
    session_id: sessionId,
    recoveries: recoveries + 1,
    nudges: 0,
    last_seq: 0,
    turn_open: 0,
    turn_started: false,
    wipe_seq: null,
    wipe_at: null,
  };
  if (next.status !== "thinking") {
    saveState(folderId, repo, next);
    return next;
  }

  const definition = loadIndex(repo);
  const last = next.history[next.history.length - 1];
  let prompt: string;
  if (next.stage === "record" && last) {
    // The answers never reached a definition write: hand them over again.
    const batch = next.batch_answers?.length ? next.batch_answers : [last];
    prompt = buildRecordPrompt(repo, batch, next.pending);
  } else if (next.history.length === 0) {
    // Still on the kickoff (the chosen starting topic is not kept; the agent
    // asks for one).
    next = { ...next, stage: null };
    prompt = kickoffPrompt(repo, definition, next.pending, null);
  } else {
    // Between questions, or the answer is already recorded: ask the next one.
    next = { ...next, stage: null };
    prompt = askNextPrompt({ repo, index: definition, pending: next.pending });
  }
  // Saved before the dispatch so the new session's first tool call finds it.
  saveState(folderId, repo, next);
  try {
    dispatchCapture(sessionId, prompt);
  } catch (e) {
    return fail(`a replacement planner session was created but could not be started: ${errMsg(e)}`, next);
  }
  return next;
}

/** Page through a session's slim event log after `afterSeq`: the new
 * high-water mark, the updated turn bookkeeping, and whether the run WE
 * dispatched last has ended. An `agent-end` only counts when it closes the
 * last open run and either a run started since our dispatch, or nothing was
 * open before it (a run that died before its `agent-start`). A run that was
 * still going at dispatch time (the user answered before the ask turn wrapped
 * up) ends with nothing started since — that late `agent-end` is the old
 * turn's, not ours. */
function readEventTail(
  sessionId: string,
  afterSeq: number,
  turn: { open: number; started: boolean },
): { lastSeq: number; ended: boolean; turn: { open: number; started: boolean } } {
  let lastSeq = afterSeq;
  let ended = false;
  let { open, started } = turn;
  for (;;) {
    const page = sessionEvents(sessionId, lastSeq, EVENTS_PAGE_LIMIT);
    if (!page.events.length) break;
    for (const e of page.events) {
      if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
      if (e.kind === "agent-start") {
        open += 1;
        started = true;
      } else if (e.kind === "agent-end") {
        const before = open;
        open = Math.max(0, open - 1);
        if (open === 0 && (started || before === 0)) ended = true;
      }
    }
    if (page.events.length < EVENTS_PAGE_LIMIT) break;
  }
  return { lastSeq, ended, turn: { open, started } };
}

/** How long a log that may or may not be the pre-wipe one is waited on before
 * it is read from the start anyway. The wipe itself takes milliseconds. */
const WIPE_GRACE_MS = 30_000;

/** After the wipe + ask dispatch: where to resume reading, or null while the
 * pre-wipe log is still in place. Core wipes asynchronously and restarts seq
 * at 1, so the old log (seq 1..wipe_seq, its last event the record turn's
 * `agent-end`) must neither be settled on nor leave a high-water mark that
 * hides every fresh event. */
function wipeResumeSeq(sessionId: string, wipeSeq: number, wipeAt: number | null): number | null {
  const probe = sessionEvents(sessionId, wipeSeq - 1, 2).events;
  // Past the old end: the session moved on (a fresh log already longer than
  // the old one, or a failed wipe the dispatch went ahead after) — either way
  // only what lies past the mark is new.
  if (probe.some((e) => e.seq > wipeSeq)) return wipeSeq;
  // The old log's last event is gone: wiped, fresh log still shorter.
  if (!probe.some((e) => e.seq === wipeSeq)) return 0;
  // Exactly the old length: still the old log — unless the wipe should long
  // have landed and the fresh log merely stopped at the same seq.
  return wipeAt !== null && Date.now() - wipeAt > WIPE_GRACE_MS ? 0 : null;
}

/** While "thinking", watch the slim event tail and drive the answer cycle:
 * a record turn that ended after writing the definition gets the wipe + fresh
 * ask turn dispatched; a run that ended without doing its job gets nudged,
 * then fails; a session that vanished is replaced (recoverSession). Tool
 * calls flip the status/stage before this runs, so a healthy run never trips
 * the nudges. A waiting slide only gets its session checked. */
function settleRun(folderId: string, repo: string, state: PlannerState): PlannerState {
  if (state.status === "waiting" && state.session_id) {
    let gone = false;
    try {
      gone = !sessionExists(state.session_id);
    } catch {
      // Unknown: check again on the next poll.
    }
    return gone ? recoverSession(folderId, repo, state) : state;
  }
  if (state.status !== "thinking" || !state.session_id) {
    return state;
  }
  const wipePending = typeof state.wipe_seq === "number" && state.wipe_seq > 0;
  let lastSeq: number;
  let ended: boolean;
  let turn: { open: number; started: boolean };
  try {
    let fromSeq = state.last_seq;
    if (wipePending) {
      const resume = wipeResumeSeq(state.session_id, state.wipe_seq as number, state.wipe_at);
      if (resume === null) return state; // the pre-wipe log is all there is yet
      fromSeq = resume;
    }
    ({ lastSeq, ended, turn } = readEventTail(state.session_id, fromSeq, {
      open: state.turn_open,
      started: state.turn_started,
    }));
  } catch {
    return state; // transient read failure — try again on the next poll
  }

  // Re-read first: an ask/write tool call may have landed while we polled
  // (toolWriteDefinition flips stage, toolAsk flips status).
  const fresh = loadState(folderId, repo);
  if (fresh.status !== "thinking") {
    return fresh;
  }
  let next: PlannerState = {
    ...fresh,
    // Across a wipe the old (higher) mark is meaningless — take the fresh one.
    last_seq: wipePending ? lastSeq : Math.max(fresh.last_seq, lastSeq),
    wipe_seq: null,
    wipe_at: null,
    turn_open: turn.open,
    turn_started: turn.started,
  };

  if (ended) {
    if (next.stage === "recorded") {
      // Phase 2 of the answer cycle: the answer is in the definition and the
      // run is idle — the only safe wipe point. Dispatch the ASK turn onto a
      // cleared session (clear_first orders wipe → dispatch inside one core
      // task). The wipe lands asynchronously and restarts seq at 1: remember
      // the old log's end so polls before the wipe don't settle on it, and
      // start the fresh log's mark at 0.
      try {
        dispatchCapture(
          state.session_id,
          askNextPrompt({
            repo,
            index: loadIndex(repo),
            pending: next.pending,
          }),
          true,
        );
        next = {
          ...next,
          stage: null,
          nudges: 0,
          last_seq: 0,
          wipe_seq: next.last_seq > 0 ? next.last_seq : null,
          wipe_at: Date.now(),
          turn_open: 0,
          turn_started: false,
        };
      } catch (e) {
        if (isSessionGone(e)) return recoverSession(folderId, repo, next);
        next = {
          ...next,
          status: "failed",
          error: `the next-question turn could not be dispatched: ${errMsg(e)}`,
        };
      }
    } else if (next.nudges < MAX_NUDGES) {
      next = { ...next, nudges: next.nudges + 1, turn_started: false };
      try {
        dispatchCapture(
          state.session_id,
          next.stage === "record" ? recordStalledPrompt() : stalledPrompt(),
        );
      } catch (e) {
        if (isSessionGone(e)) return recoverSession(folderId, repo, next);
        next = { ...next, status: "failed", error: `the planner session stopped responding: ${errMsg(e)}` };
      }
    } else {
      next = {
        ...next,
        status: "failed",
        error:
          next.stage === "record"
            ? "the planner session kept ending its runs without recording the answer"
            : "the planner session kept ending its runs without showing a slide",
      };
    }
  } else if (!sessionExists(state.session_id)) {
    return recoverSession(folderId, repo, next);
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
  // The first point where file writes are allowed: split a legacy
  // single-file definition now. Best effort — the read-only views cover it
  // until a write succeeds.
  try {
    migrateLegacy(repo);
  } catch {
    // retried on the next tool call
  }
  return { folderId, repo, state };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Validate one slide of a batch; an error string names what is wrong. */
function parseSlide(raw: any): Omit<Slide, "slide_no" | "batch_index" | "batch_size"> | { error: string } {
  const kind = asString(raw?.kind);
  const question = asString(raw?.question);
  const why = asString(raw?.why);
  const topic = asString(raw?.topic) || "Project";
  const section = asString(raw?.section);
  if (!isSection(section)) {
    return {
      error: `section is required — the definition section this answer is recorded in, one of: ${SECTION_IDS.join(", ")}`,
    };
  }
  if (kind !== "choice" && kind !== "fill") {
    return { error: "kind must be 'choice' or 'fill'" };
  }
  if (!question) return { error: "question is required" };
  if (!why) {
    return { error: "why is required — one or two sentences justifying the problem this decides" };
  }
  let options: SlideOption[] = [];
  if (kind === "choice") {
    const opts = Array.isArray(raw?.options) ? raw.options : [];
    options = opts
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
  const proposedAnswer = asString(raw?.proposed_answer) || null;
  const evidence = asString(raw?.evidence) || null;
  if (proposedAnswer && !evidence) {
    return {
      error:
        "evidence is required with proposed_answer — one sentence naming where the code shows " +
        "it, so the user can judge the conclusion",
    };
  }
  return {
    topic,
    kind,
    question,
    why,
    options,
    multi: raw?.multi === true,
    blank_hint: asString(raw?.blank_hint) || null,
    diagram: asString(raw?.diagram) || null,
    proposed_answer: proposedAnswer,
    evidence: proposedAnswer ? evidence : null,
    section,
    from_queue: asString(raw?.from_queue) || null,
  };
}

/** project_planner_ask — validate and publish the next batch of slides. */
export function toolAsk(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
  // The batch on screen IS the product: a second ask before the user answered
  // would silently replace it and the interview would stop waiting for
  // answers. Refuse so the model ends its turn instead.
  if (state.status === "waiting") {
    return {
      error:
        "slides are already showing and unanswered — do not ask again; end your turn and wait " +
        "for the user's answers to arrive as the next message",
    };
  }
  // Mid answer-cycle the record turn must stay ask-free: the next batch is
  // asked from a wiped session (the ASK turn settleRun dispatches). Slides
  // published now would skip that reset and grow the context unboundedly.
  if (state.stage === "record" || state.stage === "recorded") {
    return {
      error:
        "not yet — first record the answers via project_planner_write_definition, then END your " +
        "turn; your context is reset and the next message asks you to pose the next questions",
    };
  }
  // `questions` carries the batch; a bare single slide (the pre-batch shape)
  // is a batch of one.
  const raws: any[] = Array.isArray(args?.questions) ? args.questions : [args];
  if (raws.length < 1 || raws.length > MAX_BATCH) {
    return { error: `a batch holds 1 to ${MAX_BATCH} questions` };
  }
  const parsed: Array<Omit<Slide, "slide_no" | "batch_index" | "batch_size">> = [];
  for (const [i, raw] of raws.entries()) {
    const p = parseSlide(raw);
    if ("error" in p) {
      return { error: raws.length > 1 ? `question ${i + 1}: ${p.error}` : p.error };
    }
    parsed.push(p);
  }
  const seen = new Set<string>();
  for (const p of parsed) {
    const key = p.question.toLowerCase();
    if (seen.has(key)) return { error: `the batch asks '${p.question}' twice` };
    seen.add(key);
  }
  const slides: Slide[] = parsed.map((p, i) => ({
    ...p,
    slide_no: state.history.length + i + 1,
    batch_index: i + 1,
    batch_size: parsed.length,
  }));
  // Queue entries a slide asks leave the queue now that they are asked.
  const asked = new Set(slides.map((s) => s.from_queue).filter(Boolean));
  const pending = state.pending.filter((q) => !asked.has(q));
  // A batch is progress: the session works, so the replacement budget refills.
  saveState(folderId, repo, {
    ...state,
    status: "waiting",
    slide: slides[0],
    upcoming: slides.slice(1),
    batch_answers: [],
    answered_slides: [],
    pending,
    nudges: 0,
    recoveries: 0,
  });
  return {
    ok: true,
    note:
      `${slides.length === 1 ? "The slide is" : `All ${slides.length} slides are`} showing. End ` +
      "your turn now — the user's answers arrive together as the next message.",
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

/** project_planner_write_definition — persist ONE section of the repo's split
 * definition (the overview goes into the root file) and refresh the index. */
export function toolWriteDefinition(args: any, context: any): any {
  const { folderId, repo, state } = plannerStateFor(context);
  const section = asString(args?.section);
  if (!isSection(section)) {
    return { error: `section is required — one of: ${SECTION_IDS.join(", ")}` };
  }
  const markdown = typeof args?.markdown === "string" ? args.markdown : "";
  if (!markdown.trim() || (section !== OVERVIEW && !sectionBody(markdown))) {
    return { error: "markdown is required — the complete new body of that section" };
  }
  const path = writeSection(repo, section, markdown, asString(args?.summary) || null);
  const note = asString(args?.note) || null;
  const history = state.history.slice();
  // The note describes what the just-answered question changed — pin it there.
  if (note && history.length && history[history.length - 1].note === null) {
    history[history.length - 1] = { ...history[history.length - 1], note };
  }
  saveState(folderId, repo, {
    ...state,
    history,
    last_note: note ?? state.last_note,
    // A write during the record turn completes phase 1: settleRun sees the
    // stage and, once this turn ends, wipes the session and dispatches the
    // fresh ask turn.
    stage: state.stage === "record" ? "recorded" : state.stage,
  });
  return { ok: true, path };
}

/** project_planner_read_section — one section's full current content, so the
 * agent reads only what the next question needs. */
export function toolReadSection(args: any, context: any): any {
  const { repo } = plannerStateFor(context);
  const section = asString(args?.section);
  if (!isSection(section)) {
    return { error: `section must be one of: ${SECTION_IDS.join(", ")}` };
  }
  const content = readSection(repo, section);
  return {
    section,
    path: sectionPath(repo, section),
    content,
    ...(content === null ? { note: "not written yet" } : {}),
  };
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

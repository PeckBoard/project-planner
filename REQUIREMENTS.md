# Project Planner — Fix Requirements

**Repo:** `peck-plugins/project-planner` (own git remote: https://github.com/peckboard/project-planner)
**Host:** Peckboard. Plugin id `project-planner`. Surfaces: `folder_items` / `project_items` / `session_items` only (never global `sidebar_items`).
**Status of 0.1.0:** the slideshow boots, a temp session is created and dispatched, then the interview **fails without ever showing a question**. That is the defect. Do not add features until a real agent (not a unit-test fake) produces a first slide, the user can answer it, and a second slide appears.

This document is the handoff. Implement against it. Do not re-litigate the product: one pointed question per slide, answers become requirements in `PROJECT_DEFINITION.md` at the **folder root**.

---

## 1. The Bug (What The User Sees)

1. Open Project Planner from a folder (Folders row, or the Repos header).
2. Pick a model. Click **Begin the interview**.
3. Page shows the thinking dots.
4. After a while: **"The interview stopped"** / *"the planner session kept ending its runs without showing a slide"*.
5. No question. No choice cards. No fill-in. Reset and try again: same.

The e2e in the host (`web/e2e/tests/project-planner.spec.ts`) **encodes this failure as success**. It starts a `mock:*` session, asserts the watchdog fires, and never checks that a slide appeared. The Q→A cycle is only unit-tested by calling `toolAsk` directly (`test/planner.test.ts`). So CI is green while the product is dead.

---

## 2. How It Is Supposed To Work

```
page  POST /start     → wasm start()
                         create temp session (system_prompt = SYSTEM_PROMPT)
                         dispatchCapture(kickoffPrompt)
agent  MUST call        project_planner_ask  → status = waiting, slide stored
page  GET  /state poll  → render the slide
user  answers
page  POST /answer    → dispatchCapture(answerPrompt)
agent  MUST             project_planner_write_definition  (full file, one req changed)
                        then project_planner_ask  (or _finish)
```

**The slideshow never sees chat text.** `peckboard_session_events` is slim (`{seq, kind, name}` — no payloads). The **only** channel from agent to UI is the four MCP tools:

| Tool | Effect |
|---|---|
| `project_planner_ask` | Publish one slide; `status = waiting` |
| `project_planner_queue` | Add/remove pending follow-ups |
| `project_planner_write_definition` | Write `PROJECT_DEFINITION.md`; does **not** leave thinking |
| `project_planner_finish` | `status = done` + summary |

If the agent writes a paragraph instead of calling `project_planner_ask`, the user sees nothing. The watchdog (`settleRun` in `src/planner.ts`) treats `agent-end` while still `thinking` as a stall: nudge (`stalledPrompt`) twice (`MAX_NUDGES = 2`), then fail.

Tools refuse anyone except the folder's own planner `session_id` (`plannerStateFor`). That guard stays.

---

## 3. Why Questions Do Not Appear (Ranked)

Investigate in this order. Fix what is actually true; do not shotgun.

### 3.1 Kickoff tells the agent to write first, then stop is legal

`kickoffPrompt` (no existing file):

> First call `project_planner_write_definition` to seed the skeleton … then ask your first question.

`toolWriteDefinition` leaves `status = "thinking"`. Many models call one tool and end the turn. `settleRun` then sees `agent-end` with no slide → nudge → fail.

**Required:** the first user-visible outcome of a start is a **question**, not a file write. Either:

- Kickoff must demand `project_planner_ask` as the **first** tool call (seed the file on the first answer, or seed it inside `start()` without the agent), **or**
- `write_definition` on an empty interview must not count as "the run ended" — the watchdog must wait for ask/finish, not treat a successful write + `agent-end` as a stall.

Prefer making `start()` write the empty skeleton itself (headings only) and making kickoff a single instruction: **call `project_planner_ask` now, purpose first.** One tool, one slide.

### 3.2 The agent may not see the tools

Host wiring (Peckboard core, not this repo):

- Plugin `mcp_tools` are merged into `/mcp` `tools/list` (`src/routes/mcp.rs`).
- `SessionManager::final_config` copies plugin tool names into `SpawnConfig.extra_allowed_tools`.
- **Claude CLI:** those names become `--allowedTools=mcp__peckboard__project_planner_ask,…`.
- **Grok CLI:** `--allow=MCPTool(peckboard__*)` (wildcard). Grok names tools `peckboard__project_planner_ask` via `search_tool` / `use_tool`, **not** as first-class functions.

Confirm on a live start:

1. Temp session exists (`is_temp`, folder-scoped, `system_prompt` contains `project_planner_ask`).
2. Session MCP `tools/list` includes all four `project_planner_*` tools.
3. The spawned CLI actually has them allowed (Claude argv / Grok `--allow`).
4. The model you picked uses tools at all (see 3.4).

If tools are missing, that is a **host** bug — file it against Peckboard and unblock the plugin with a documented workaround. Do not pretend the plugin can fix a missing allowlist by shouting louder in the prompt.

### 3.3 Watchdog cannot see *why* the run ended

Events are slim. `settleRun` only looks for `kind === "agent-end"`. It cannot tell "called a tool and stopped" from "wrote a novel in chat". There is no link from the temp session into the UI (no "open the interview session" affordance, no last error, no last tool name).

**Required for debug, keep it small:**

- Persist the last watchdog reason with more than one sentence: whether `agent-end` fired, nudge count, and whether *any* planner tool was invoked this run.
- Optionally surface a "Open interview session" control so a human can see the transcript. Temp sessions vanish when their tab is closed — `sessionExists` uses `peckboard_list_sessions_brief`; if temps are omitted there, the page will false-fail with "the planner session is gone". Verify that. If true, stop using brief-list as liveness, or pin the session until reset.

### 3.4 Model picker is not the contract the e2e describes

`pageState` returns **every** `peckboard_list_models()` entry. The e2e comment says "thinking models only". The start screen preselects highest `tier`.

A non-tool-using / non-thinking model will never call `project_planner_ask`.

**Required:** only offer models that can call MCP tools. Prefer thinking / high-tier. Disable Begin if the list is empty. Say why.

### 3.5 Prompt vs product

`SYSTEM_PROMPT` already says the user only sees `project_planner_ask`. That is not enough if 3.1–3.4 hold. After those are fixed, tighten:

- First action of a new run: **one** `project_planner_ask` (purpose).
- After an answer: write definition **and** ask (or finish) **in the same turn**.
- Never end a turn with no ask/finish while the interview is open.
- `stalledPrompt` should name the tool and the next topic (purpose if the definition has no Purpose yet), not a vague "ask the next question".

Do not grow the prompt. It must stay small: definition + queue are re-injected every dispatch on purpose.

---

## 4. Required Behaviour (Acceptance)

A run against a **real** tool-using model (Claude or Grok with Peckboard MCP), empty folder, no existing `PROJECT_DEFINITION.md`:

| Step | Must happen |
|---|---|
| Begin | Status → `thinking` immediately. |
| First slide | Within a bounded time (watchdog must not fire first), `status = waiting` and the page shows **one** question about **purpose**, with `why` filled. Choice: 2–5 options each with a trade-off sentence. Fill: `___` in the question + `blank_hint`. |
| Answer | Status → `thinking`. `PROJECT_DEFINITION.md` exists at folder root with a Purpose requirement reflecting the answer. Then a **second** slide (goal, or users — not architecture yet). |
| Order | No architecture / tools / DB / deploy / stories until Purpose **and** Goal are in the file (`SYSTEM_PROMPT` already says this; enforce in tests with fixture definitions). |
| Finish | When the agent calls `project_planner_finish`, user sees the summary. File remains. |
| Reset | Clears interview state only. File stays. |
| Existing file | Kickoff continues from it; does not re-ask answered purpose/goal. |
| Failure | If the agent truly never asks, fail with a message that names the cause (no tools / session gone / N nudges). Never a silent hang. |

Non-goals until the above works: diagrams polish, multi-folder interviews, per-repo definitions, global sidebar entry, streaming tokens on the slide.

---

## 5. Constraints (Do Not Break)

- Folder-scoped. `x-peckboard-folder-id` (or project/session that resolves to a folder). No `sidebar_items`.
- Definition path is always `PROJECT_DEFINITION.md` at the folder root (`DEFINITION_FILE` in `src/prompt.ts`).
- Tools only from the interview session (`plannerStateFor`).
- Page is sandboxed: parent-proxied fetch, `textContent` for agent strings, no `innerHTML` for model output. Definition preview may use the existing escape-first markdown helper (`page/md.js`).
- Host functions used today stay lazy (inside functions) so vitest can load modules without Extism (`src/host.ts`).
- `dist/` is gitignored; ship via `./build.sh` → `dist/plugin.wasm`, copy to `<data-dir>/plugins/project-planner.wasm`, operator re-approves if permissions/hooks change.
- Peckboard migrations: this plugin must not require host schema changes. If you need a host fix (MCP allowlist, temp-session listing), call it out as a Peckboard PR with this plugin depending on it.

---

## 6. Implementation Notes (Suggested Shape)

Keep the state machine in `src/planner.ts`. Likely edits:

| File | Change |
|---|---|
| `src/planner.ts` `start()` | Seed empty definition headings here if the file is missing. Do not ask the model to seed. |
| `src/prompt.ts` `kickoffPrompt` | Single order: ask purpose via `project_planner_ask` now. Drop "write first then ask". |
| `src/prompt.ts` `stalledPrompt` | Concrete: call `project_planner_ask` for purpose (or the next gap). |
| `src/planner.ts` `settleRun` | Do not fail a run that successfully wrote but has not asked yet without a nudge that **requires** ask. Consider ignoring `agent-end` until a grace poll if a tool ran this turn. |
| `src/planner.ts` `pageState` / start UI | Filter models to tool-capable; empty-state copy. |
| `page/main.js` | Failed screen: show the real error. Optional: link/open the interview session. |
| `test/planner.test.ts` | Kickoff no longer expects "seed the skeleton" from the agent. Assert `start()` writes headings. Assert ask-first. |
| Host e2e | **Replace** the "watchdog on a tool-less mock" test as the sole happy path. Add a path that injects / drives `project_planner_ask` (or uses a mock scenario that **does** call it) and asserts a slide with the question text. Keep a separate test for the stall failure. |

Do not invent a second channel (parsing `agent-text` events). Slim events have no payload; that path cannot carry a question.

---

## 7. File Map

| Path | Role |
|---|---|
| `src/prompt.ts` | `SYSTEM_PROMPT`, kickoff / answer / stall prompts |
| `src/planner.ts` | State, start/answer/reset, watchdog, four tools |
| `src/lib.ts` | Hook dispatch → tools |
| `src/http.ts` | `GET` page, `GET state`, `POST start/answer/reset` |
| `src/host.ts` | Extism host FFI |
| `src/manifest.ts` | Hooks, permissions, MCP tool schemas, page items |
| `page/main.js` | Slideshow |
| `test/planner.test.ts` | State machine (fake host) |
| `test/prompt.test.ts` | Contract strings |
| Peckboard `web/e2e/tests/project-planner.spec.ts` | Currently proves the **failure** path |

---

## 8. Definition Of Done

1. `npm test` in this repo passes (updated for ask-first / server-side seed).
2. `./build.sh` produces `dist/plugin.wasm`.
3. Against a **tmp** Peckboard with this wasm approved, using a tool-using mock **or** a real Claude/Grok account:
   - Begin → first **purpose** slide appears (not the fail screen).
   - Answer → file on disk has that requirement → second slide appears.
4. Host e2e asserts a slide is shown, not only that the watchdog fires.
5. Manual: Folders → Project Planner, and Repos header → Project Planner, same interview.
6. README matches the new kickoff (no "agent seeds the skeleton first").

Do not release until (3) is true on a non-mock model the user actually picks.

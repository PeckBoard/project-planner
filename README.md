# Project Planner (Peckboard Plugin)

Builds a project definition file by interview. A slideshow asks one pointed
question per slide — fill-in-the-blank or multiple choice with every option
justified, plus small diagrams — each generated after the last by the same
agent session. Every answer is written into `PROJECT_DEFINITION.md` at the
folder root as a requirement.

- **id**: `project-planner`
- **repository**: <https://github.com/peckboard/project-planner>

## How It Works

```
page (sandboxed iframe)          plugin (wasm)                agent session
POST /start ───────────────────▶ create temp session
                                 + planner system prompt
                                 + kickoff dispatch ─────────▶ reads definition + queue
GET /state (poll) ◀───────────── store: waiting ◀──────────── project_planner_ask (one slide)
render slide, user answers
POST /answer ──────────────────▶ dispatch answer ───────────▶ project_planner_write_definition
                                                              (ONE requirement added/amended)
                                                              project_planner_queue (split
                                                              complex topics, prune)
                                                              project_planner_ask (next) …
                                                              project_planner_finish (done)
```

Session events are payload-slim (`{seq, kind, name}`), so the agent's output
only reaches the plugin through the four MCP tools above. The slim tail is
used for one thing: a watchdog that nudges a run that ended without asking
(twice), then fails the interview with an explicit message.

## The Contract (Why the Questions Stay Good)

The session's system prompt (`src/prompt.ts`) pins:

- Purpose and goal first — no architecture / tools / database / deployment /
  user-story questions until they are recorded in the definition.
- One pointed question per slide, simple language, no lists, understandable
  in a vacuum (`why` carries the problem's justification).
- Choice options each carry a one-sentence justification naming a trade-off,
  so options compare; fill-in-the-blank slides phrase the sentence with `___`.
- Complex topics split into queued follow-ups (`project_planner_queue`); the
  queue is re-shown with every answer and the agent picks the next question.
- After every answer, the FULL updated definition is rewritten with exactly
  one requirement added or amended.
- An existing `PROJECT_DEFINITION.md` is read into the kickoff prompt and the
  interview continues from it.
- Context stays small: definition + queue arrive with every message, so the
  session never re-reads files or explores the repo.

## Surfaces

- `folder_items` / `project_items` / `session_items` page (never a global
  `sidebar_items` entry — a global page carries no scope header, and every
  route here is folder-scoped).
- `ui_routes`: `GET state`, `POST start`, `POST answer`, `POST reset` under
  `/api/plugin-ui/project-planner/`.
- Diagrams: the slide's optional mermaid source renders via CDN mermaid when
  reachable and falls back to a styled text block offline.

## Build

```bash
./build.sh          # → dist/plugin.wasm (needs extism-js + node)
npm test            # vitest: manifest, contract, state machine, ffi, markdown
```

Install by copying `dist/plugin.wasm` to `<data-dir>/plugins/project-planner.wasm`
(or via the registry once published) and approving the hooks + permissions in
Settings → Plugins. E2e coverage lives in
`web/e2e/tests/project-planner.spec.ts`.

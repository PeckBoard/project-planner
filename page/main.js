// Project Planner slideshow. Runs inside PeckBoard's sandboxed plugin iframe
// (opaque origin, no auth token) — all data flows through the parent-proxied
// postMessage fetch bridge (see peckboard/web/src/components/PluginFullPage.tsx).
//
// One screen at a time: start → (thinking ⇄ slide)* → done, plus a failed
// screen and a collapsible definition preview. All agent-provided strings are
// rendered with textContent (never innerHTML); the definition preview goes
// through a tiny escape-first markdown renderer.

import { CSS } from "./style.js";

const P = "/api/plugin-ui/project-planner";
const POLL_THINKING_MS = 1500;
const POLL_IDLE_MS = 6000;

// ── theme ────────────────────────────────────────────────────────────────────

const mediaDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
(function stampTheme() {
  const q = new URLSearchParams(window.location.search).get("theme");
  const theme = q === "dark" || q === "light" ? q : mediaDark && mediaDark.matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
})();

// ── parent-proxied fetch bridge ──────────────────────────────────────────────

const pending = new Map();
let seq = 0;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.type === "plugin-ui-fetch-result" && pending.has(m.requestId)) {
    const cb = pending.get(m.requestId);
    pending.delete(m.requestId);
    cb(m);
  }
});

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const requestId = ++seq;
    pending.set(requestId, (m) => {
      let data = null;
      try {
        data = m.body ? JSON.parse(m.body) : null;
      } catch (_e) {
        // non-JSON error body; fall through to the status check
      }
      if (m.status >= 200 && m.status < 300) resolve(data || {});
      else reject(new Error((data && data.error) || "request failed (HTTP " + m.status + ")"));
    });
    parent.postMessage(
      {
        type: "plugin-ui-fetch",
        requestId,
        method,
        path,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      "*",
    );
  });
}
const getJSON = (path) => api("GET", path);
const postJSON = (path, body) => api("POST", path, body || {});

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
  return n;
}
// Static, trusted markup only (icons) — data never goes through innerHTML.
function icon(paths) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.innerHTML = paths;
  return s;
}
const ICON_CLIPBOARD =
  '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>';
const ICON_CHECK = '<path d="M20 6 9 17l-5-5"/>';

// ── mermaid (best effort, CDN; styled text fallback offline) ─────────────────

let mermaidState = "unloaded"; // unloaded | loading | ready | failed
const mermaidWaiters = [];
function withMermaid(cb) {
  if (mermaidState === "ready") return cb(window.mermaid);
  if (mermaidState === "failed") return cb(null);
  mermaidWaiters.push(cb);
  if (mermaidState === "loading") return;
  mermaidState = "loading";
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
  s.onload = () => {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral",
      });
      mermaidState = "ready";
    } catch (_e) {
      mermaidState = "failed";
    }
    mermaidWaiters.splice(0).forEach((w) => w(mermaidState === "ready" ? window.mermaid : null));
  };
  s.onerror = () => {
    mermaidState = "failed";
    mermaidWaiters.splice(0).forEach((w) => w(null));
  };
  document.head.appendChild(s);
}

let diagramSeq = 0;
function renderDiagram(container, source) {
  const fallback = () => {
    clear(container);
    const pre = el("pre");
    pre.textContent = source;
    container.appendChild(pre);
    container.appendChild(el("div", "diagram-caption", "Diagram (text form)"));
  };
  fallback(); // show something immediately; upgrade when mermaid arrives
  withMermaid((mermaid) => {
    if (!mermaid || !container.isConnected) return;
    mermaid
      .render("planner-diagram-" + ++diagramSeq, source)
      .then(({ svg }) => {
        if (!container.isConnected) return;
        clear(container);
        // Mermaid output with securityLevel "strict" — sanitized by mermaid.
        const holder = el("div");
        holder.innerHTML = svg;
        container.appendChild(holder);
        container.appendChild(el("div", "diagram-caption", "Diagram"));
      })
      .catch(() => {
        /* keep the text fallback */
      });
  });
}

// ── definition preview markdown (pure module, unit-tested) ───────────────────

import { markdownToHtml } from "./md.js";

// ── app state ────────────────────────────────────────────────────────────────

const app = document.getElementById("app");
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

let state = null; // last /state payload
let lastSlideNo = -1; // re-render slides only when the slide changes
let showDefinition = false;
let chosen = new Set(); // selected option labels
let otherText = "";
let submitting = false;
let pollTimer = null;
// Interviews are repo-scoped: a folder can hold several git repos, each with
// its own definition file, interview, and reset. `currentRepo` is the
// folder-relative path ('.' = the folder root); null shows the picker.
let repos = null; // last /repos payload (list), or null before the first load
let currentRepo = null;
// sessionStorage THROWS in this sandboxed iframe (opaque origin, no
// allow-same-origin) — remembering the picked repo is best-effort only.
function remember(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch (_e) {
    /* opaque origin — selection lives for this page load only */
  }
}
function recall(k) {
  try {
    return sessionStorage.getItem(k);
  } catch (_e) {
    return null;
  }
}
function forget(k) {
  try {
    sessionStorage.removeItem(k);
  } catch (_e) {
    /* nothing to forget */
  }
}

// Live reference into the mounted generating screen, so polls can update the
// real definition-change note without rebuilding the DOM (a rebuild restarts
// the dot animation — it reads as flicker, not loading). No fabricated
// step-by-step captions: the page cannot see what the agent is doing, so it
// says only what it knows — a question is being generated.
let thinkingNoteEl = null;

function schedulePoll() {
  clearTimeout(pollTimer);
  const ms = state && state.status === "thinking" ? POLL_THINKING_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(refresh, ms);
}

// Deep link from the repo browser: the host forwards the app URL's query
// into the iframe, so `?repo=<path>` opens the planner directly on that
// repo ('.' = folder root). It outranks the remembered pick.
const urlRepo = new URLSearchParams(window.location.search).get("repo");

async function refresh() {
  try {
    if (repos === null) {
      repos = (await getJSON(P + "/repos")).repos || [];
      const remembered = recall("planner-repo");
      if (currentRepo === null) {
        if (urlRepo && repos.some((r) => r.path === urlRepo)) currentRepo = urlRepo;
        else if (repos.length === 1) currentRepo = repos[0].path;
        else if (remembered && repos.some((r) => r.path === remembered)) currentRepo = remembered;
      }
    }
    if (currentRepo === null) {
      // No repo picked yet — keep the picker fresh, re-render only on change.
      const next = (await getJSON(P + "/repos")).repos || [];
      const changed = JSON.stringify(next) !== JSON.stringify(repos) || !state || state.status !== "pick-repo";
      repos = next;
      state = { status: "pick-repo" };
      if (changed) render();
      schedulePoll();
      return;
    }
    const next = await getJSON(P + "/state?repo=" + encodeURIComponent(currentRepo));
    const slideChanged =
      (next.slide ? next.slide.slide_no : -1) !== (state && state.slide ? state.slide.slide_no : -1);
    const statusChanged = !state || state.status !== next.status;
    const noteChanged = state && state.last_note !== next.last_note;
    // First definition write lands mid-generation — re-render so the topbar
    // gains its "View definition" toggle without waiting for the slide.
    const defChanged = state && state.definition_exists !== next.definition_exists;
    state = next;
    if (statusChanged || slideChanged || defChanged) {
      render();
    } else if (state.status === "thinking" && noteChanged) {
      updateThinkingNote();
    }
  } catch (e) {
    state = { status: "bridge-error", error: e.message };
    render();
  }
  schedulePoll();
}

function selectRepo(path) {
  currentRepo = path;
  remember("planner-repo", path);
  state = null;
  showDefinition = false;
  render();
  refresh();
}

function switchRepo() {
  currentRepo = null;
  forget("planner-repo");
  state = null;
  repos = null;
  showDefinition = false;
  render();
  refresh();
}

// ── screens ──────────────────────────────────────────────────────────────────

function render() {
  clear(app);
  const stage = el("div", "stage");
  const inner = el("div", "stage-inner");
  stage.appendChild(inner);
  app.appendChild(stage);

  inner.appendChild(topbar());
  if (!state) {
    inner.appendChild(loadingCard("Loading…"));
    return;
  }
  switch (state.status) {
    case "pick-repo":
      inner.appendChild(repoPickerScreen());
      break;
    case "idle":
      inner.appendChild(startScreen());
      break;
      break;
    case "thinking":
      inner.appendChild(trail(true));
      inner.appendChild(thinkingScreen());
      break;
    case "waiting":
      inner.appendChild(trail(false));
      inner.appendChild(slideScreen());
      break;
    case "done":
      inner.appendChild(doneScreen());
      break;
    case "failed":
      inner.appendChild(failedScreen(state.error || "The interview stopped unexpectedly."));
      break;
    default:
      inner.appendChild(failedScreen(state.error || "The page lost its connection."));
  }
  if (showDefinition) inner.appendChild(definitionPanel());
}

function topbar() {
  const bar = el("div", "topbar");
  const brand = el("div", "brand");
  const bi = el("span", "brand-icon");
  bi.appendChild(icon(ICON_CLIPBOARD));
  brand.appendChild(bi);
  brand.appendChild(el("span", "", "Project Planner"));
  bar.appendChild(brand);
  if (currentRepo !== null) {
    const info = (repos || []).find((r) => r.path === currentRepo);
    bar.appendChild(el("span", "repo-chip", info ? info.name : currentRepo));
  }
  bar.appendChild(el("div", "topbar-spacer"));
  if (currentRepo !== null) {
    const back = el("button", "ghost-btn", "Switch repo");
    back.onclick = switchRepo;
    bar.appendChild(back);
  }
  if (state && state.definition_exists) {
    bar.appendChild(el("span", "file-chip", state.definition_file || "PROJECT_DEFINITION.md"));
    const toggle = el("button", "ghost-btn", showDefinition ? "Hide definition" : "View definition");
    toggle.onclick = () => {
      showDefinition = !showDefinition;
      render();
    };
    bar.appendChild(toggle);
  }
  if (
    currentRepo !== null &&
    state &&
    (state.status === "waiting" ||
      state.status === "thinking" ||
      state.status === "failed" ||
      state.status === "done")
  ) {
    const stop = el("button", "ghost-btn", "Start over");
    stop.onclick = async () => {
      try {
        await postJSON(P + "/reset", { repo: currentRepo });
        showDefinition = false;
        await refresh();
      } catch (_e) {
        /* surfaced on next poll */
      }
    };
    bar.appendChild(stop);
  }
  return bar;
}

/** Human status line for a repo row on the picker. */
function repoStatusLabel(r) {
  switch (r.status) {
    case "waiting":
      return "waiting for your answer";
    case "thinking":
      return "generating a question";
    case "done":
      return "complete";
    case "failed":
      return "stopped — reset to retry";
    default:
      return r.definition_exists ? "definition on disk — not started" : "not started";
  }
}

/** One interview per git repo: the folder holds several, so pick one. */
function repoPickerScreen() {
  const card = el("div", "card");
  const head = el("div", "center");
  const hero = el("div", "hero-icon");
  hero.appendChild(icon(ICON_CLIPBOARD));
  head.appendChild(hero);
  head.appendChild(el("h1", "", "Pick a repository"));
  head.appendChild(
    el(
      "p",
      "copy",
      (repos || []).length
        ? "Each git repo in this folder gets its own definition file and its own interview."
        : "No git repositories were found in this folder or its subfolders.",
    ),
  );
  card.appendChild(head);
  const list = el("div", "repo-list");
  for (const r of repos || []) {
    const row = el("button", "repo-row");
    row.type = "button";
    const body = el("div", "repo-row-body");
    const title = el("div", "repo-row-name", r.name);
    title.appendChild(el("span", "repo-branch", r.branch));
    body.appendChild(title);
    body.appendChild(
      el(
        "div",
        "repo-row-meta",
        (r.path === "." ? "" : r.path + " · ") +
          repoStatusLabel(r) +
          (r.answered ? " · " + r.answered + " answered" : ""),
      ),
    );
    row.appendChild(body);
    row.appendChild(el("span", "repo-row-go", "›"));
    row.onclick = () => selectRepo(r.path);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function trail(thinking) {
  const t = el("div", "trail");
  const answered = state.answered || 0;
  for (let i = 0; i < answered; i++) {
    const dot = el("span", "trail-dot");
    const past = state.history && state.history[i];
    if (past && past.topic) dot.title = past.topic + (past.note ? " — " + past.note : "");
    t.appendChild(dot);
  }
  const current = el("span", "trail-dot current");
  t.appendChild(current);
  t.appendChild(
    el(
      "span",
      "trail-label",
      thinking
        ? `${answered} answered`
        : `${answered} answered · slide ${answered + 1}`,
    ),
  );
  return t;
}

function loadingCard(text) {
  const card = el("div", "card center");
  card.appendChild(el("div", "thinking-line", text));
  return card;
}

function startScreen() {
  const card = el("div", "card center");
  const hero = el("div", "hero-icon");
  hero.appendChild(icon(ICON_CLIPBOARD));
  card.appendChild(hero);
  card.appendChild(el("h1", "", "Plan this project, one question at a time"));
  card.appendChild(
    el(
      "p",
      "copy",
      "An agent interviews you slide by slide — purpose first, then users, stories, " +
        "architecture, tools, and deployment. Every answer becomes a requirement in the " +
        "project definition file.",
    ),
  );
  if (state.definition_exists) {
    card.appendChild(
      el(
        "div",
        "notice",
        "A definition file already exists — the interview reads it first and continues from it.",
      ),
    );
  }
  const row = el("div", "model-row");
  const select = el("select", "model-select");
  select.setAttribute("aria-label", "Model for the planner session");
  const models = state.models || [];
  if (!models.length) {
    const opt = el("option", "", "No models available");
    opt.value = "";
    select.appendChild(opt);
  }
  for (const m of models) {
    const opt = el("option", "", m.display_name || m.id);
    opt.value = m.id;
    select.appendChild(opt);
  }
  // Highest tier preselected: planning benefits from the strongest model.
  const best = models.slice().sort((a, b) => (b.tier || 0) - (a.tier || 0))[0];
  if (best) select.value = best.id;
  row.appendChild(select);
  card.appendChild(row);

  // Optional steer: a freeform starting topic the interview digs into first.
  const topicRow = el("div", "model-row");
  const topicInput = el("input", "topic-input");
  topicInput.type = "text";
  topicInput.maxLength = 200;
  topicInput.placeholder = "Start with a topic (optional) — e.g. game rules";
  topicInput.setAttribute("aria-label", "Optional starting topic for the interview");
  topicRow.appendChild(topicInput);
  card.appendChild(topicRow);

  const err = el("div", "error-box");
  err.style.display = "none";
  card.appendChild(err);

  const btn = el("button", "primary-btn", "Begin the interview");
  btn.disabled = !models.length;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      await postJSON(P + "/start", {
        repo: currentRepo,
        model: select.value,
        topic: topicInput.value.trim(),
      });
      await refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = "";
      btn.disabled = false;
      btn.textContent = "Begin the interview";
    }
  };
  card.appendChild(btn);
  return card;
}

/** The generating screen: shown whenever the next question is not ready yet
 * (interview start and after every answer). Built ONCE per thinking phase;
 * only the real definition-change note is patched in afterwards. Nothing
 * here narrates invented steps — the page cannot see the agent's progress. */
function thinkingScreen() {
  const card = el("div", "card center");
  card.appendChild(
    el("h1", "", state.answered > 0 ? "Generating the next question…" : "Preparing the first question…"),
  );
  const dots = el("div", "dots");
  for (let i = 0; i < 3; i++) dots.appendChild(el("i"));
  card.appendChild(dots);
  thinkingNoteEl = el("div", "last-note");
  card.appendChild(thinkingNoteEl);
  updateThinkingNote();
  return card;
}

/** Patch the note line under the generating dots ("✓ Recorded the purpose")
 * when the agent reports a definition change mid-generation. */
function updateThinkingNote() {
  if (!thinkingNoteEl || !thinkingNoteEl.isConnected) return;
  thinkingNoteEl.textContent = state && state.last_note ? "✓ " + state.last_note : "";
}

function slideScreen() {
  const s = state.slide;
  const isNewSlide = chosenGuard(s);
  // A confirmed-or-corrected slide starts prefilled with what the code
  // suggests, so Confirm and Submit agree until the user changes something.
  if (isNewSlide && s.proposed_answer) {
    if (s.kind === "fill") {
      otherText = s.proposed_answer;
    } else {
      const match = s.options.find(
        (o) => o.label.trim().toLowerCase() === s.proposed_answer.trim().toLowerCase(),
      );
      if (match) chosen.add(match.label);
    }
  }
  const card = el("div", "card");
  card.dataset.slide = String(s.slide_no);

  const head = el("div", "card-head");
  head.appendChild(el("span", "topic-chip", s.topic));
  head.appendChild(el("span", "slide-no", "Slide " + s.slide_no));
  if (state.pending_count > 0) {
    head.appendChild(
      el("span", "queue-badge", state.pending_count + " queued"),
    );
  }
  card.appendChild(head);

  // Question — for fill slides the ___ becomes a styled blank.
  const q = el("h2", "question");
  if (s.kind === "fill" && s.question.includes("___")) {
    const parts = s.question.split("___");
    parts.forEach((part, i) => {
      q.appendChild(document.createTextNode(part));
      if (i < parts.length - 1) q.appendChild(el("span", "blank", " "));
    });
  } else {
    q.textContent = s.question;
  }
  card.appendChild(q);

  const why = el("div", "why");
  const whyBody = el("div");
  const whyTitle = el("b", "", "Why this matters. ");
  whyBody.appendChild(whyTitle);
  whyBody.appendChild(document.createTextNode(s.why));
  why.appendChild(whyBody);
  card.appendChild(why);

  if (s.diagram) {
    const d = el("div", "diagram");
    card.appendChild(d);
    renderDiagram(d, s.diagram);
  }

  const err = el("div", "error-box");
  err.style.display = "none";

  // Shared submit path for both the proposal's Confirm and the normal button.
  const send = async (answerText, btn, busyLabel, idleLabel) => {
    if (submitting || !answerText) return;
    submitting = true;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await postJSON(P + "/answer", { repo: currentRepo, answer: answerText });
      chosen = new Set();
      otherText = "";
      await refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = "";
      btn.textContent = idleLabel;
      btn.disabled = false;
    } finally {
      submitting = false;
    }
  };

  // The code already answers this: show the conclusion + its evidence with a
  // one-click Confirm. The regular controls below stay live as the
  // correction path — answering normally overrides the proposal.
  if (s.proposed_answer) {
    const panel = el("div", "proposal");
    panel.appendChild(el("span", "proposal-chip", "Found in your code"));
    const body = el("div", "proposal-body");
    body.appendChild(el("div", "proposal-answer", s.proposed_answer));
    if (s.evidence) body.appendChild(el("div", "proposal-evidence", s.evidence));
    panel.appendChild(body);
    const confirm = el("button", "primary-btn proposal-confirm", "Confirm");
    confirm.onclick = () => send(s.proposed_answer, confirm, "Sending…", "Confirm");
    panel.appendChild(confirm);
    card.appendChild(panel);
  }

  let getAnswer;
  if (s.kind === "choice") {
    const list = el("div", "options");
    for (const o of s.options) {
      list.appendChild(optionCard(s, o, () => syncSubmit()));
    }
    // Free-text escape hatch so a missing option never blocks the interview.
    list.appendChild(otherCard(s, () => syncSubmit()));
    card.appendChild(list);
    getAnswer = () => {
      const picked = s.options.filter((o) => chosen.has(o.label)).map((o) => o.label);
      if (chosen.has("__other__") && otherText.trim()) picked.push(otherText.trim());
      return picked.join("; ");
    };
  } else {
    const input = el("input", "fill-input");
    input.placeholder = s.blank_hint || "Type your answer…";
    input.value = otherText;
    input.oninput = () => {
      otherText = input.value;
      syncSubmit();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !submit.disabled) submit.onclick();
    };
    card.appendChild(input);
    if (!s.proposed_answer) setTimeout(() => input.focus(), 50);
    getAnswer = () => otherText.trim();
  }

  card.appendChild(err);

  const actions = el("div", "actions");
  const submit = el("button", "primary-btn", "Submit answer");
  submit.onclick = () => send(getAnswer(), submit, "Sending…", "Submit answer");
  actions.appendChild(submit);
  actions.appendChild(
    el(
      "span",
      "action-hint",
      s.proposed_answer
        ? "Confirm what the code shows, or answer differently here"
        : s.kind === "choice"
          ? s.multi
            ? "Pick one or more"
            : "Pick one"
          : "Fill in the blank",
    ),
  );
  card.appendChild(actions);

  function syncSubmit() {
    submit.disabled = !getAnswer();
  }
  syncSubmit();
  return card;
}

/** Reset selection state when a new slide arrives; true when it did. Keyed
 * on number + question so slide 1 of a fresh interview (after a reset)
 * still counts as new. */
function chosenGuard(slide) {
  const key = slide.slide_no + ":" + slide.question;
  if (lastSlideNo !== key) {
    lastSlideNo = key;
    chosen = new Set();
    otherText = "";
    return true;
  }
  return false;
}
function optionCard(slide, option, onChange) {
  const btn = el("button", "option" + (slide.multi ? " multi-mark" : ""));
  btn.type = "button";
  const mark = el("span", "option-mark");
  mark.appendChild(icon(ICON_CHECK));
  btn.appendChild(mark);
  const body = el("div", "option-body");
  body.appendChild(el("div", "option-label", option.label));
  body.appendChild(el("div", "option-detail", option.detail));
  btn.appendChild(body);
  const sync = () => btn.classList.toggle("selected", chosen.has(option.label));
  btn.onclick = () => {
    if (chosen.has(option.label)) {
      chosen.delete(option.label);
    } else {
      if (!slide.multi) {
        chosen.clear();
      }
      chosen.delete("__other__");
      chosen.add(option.label);
    }
    // Re-sync every option's visual state.
    btn.closest(".options")
      .querySelectorAll(".option")
      .forEach((n) => n.dispatchEvent(new CustomEvent("sync")));
    onChange();
  };
  btn.addEventListener("sync", sync);
  sync();
  return btn;
}

function otherCard(slide, onChange) {
  // Not a <button>: a native button's Space/Enter activation is a default
  // action that fires even when the nested input stops key propagation, so
  // typing a space into the answer field would toggle the option off and
  // hide the input mid-word. A div[role=button] has no default activation;
  // keyboard toggling is handled below only when the card itself has focus.
  const btn = el("div", "option" + (slide.multi ? " multi-mark" : ""));
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.onkeydown = (e) => {
    if (e.target !== btn) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      btn.click();
    }
  };
  const mark = el("span", "option-mark");
  mark.appendChild(icon(ICON_CHECK));
  btn.appendChild(mark);
  const body = el("div", "option-body");
  body.appendChild(el("div", "option-label", "Something else"));
  body.appendChild(el("div", "option-detail", "None of these fit — describe it in your own words."));
  const input = el("input", "option-input");
  input.placeholder = "Your answer…";
  input.style.display = "none";
  input.onclick = (e) => e.stopPropagation();
  input.oninput = () => {
    otherText = input.value;
    onChange();
  };
  body.appendChild(input);
  btn.appendChild(body);
  const sync = () => {
    const on = chosen.has("__other__");
    btn.classList.toggle("selected", on);
    input.style.display = on ? "" : "none";
  };
  btn.onclick = () => {
    if (chosen.has("__other__")) {
      chosen.delete("__other__");
    } else {
      if (!slide.multi) chosen.clear();
      chosen.add("__other__");
      setTimeout(() => input.focus(), 30);
    }
    btn.closest(".options")
      .querySelectorAll(".option")
      .forEach((n) => n.dispatchEvent(new CustomEvent("sync")));
    onChange();
  };
  btn.addEventListener("sync", sync);
  sync();
  return btn;
}

function doneScreen() {
  const card = el("div", "card center");
  const hero = el("div", "hero-icon");
  hero.appendChild(icon(ICON_CHECK));
  card.appendChild(hero);
  card.appendChild(el("h1", "", "The definition is complete"));
  if (state.summary) {
    card.appendChild(el("div", "summary", state.summary));
  }
  const btn = el("button", "primary-btn", "Run another pass");
  btn.onclick = async () => {
    try {
      await postJSON(P + "/reset", { repo: currentRepo });
      showDefinition = false;
      await refresh();
    } catch (_e) {
      /* surfaced on next poll */
    }
  };
  card.appendChild(btn);
  if (state.definition_exists && !showDefinition) {
    showDefinition = true;
    // definitionPanel is appended by render(); flag flip is enough.
  }
  return card;
}

function failedScreen(message) {
  const card = el("div", "card center");
  card.appendChild(el("h1", "", "The interview stopped"));
  const err = el("div", "error-box", message);
  err.style.display = "";
  card.appendChild(err);
  const btn = el("button", "primary-btn", "Reset and start again");
  btn.onclick = async () => {
    try {
      await postJSON(P + "/reset", { repo: currentRepo });
      await refresh();
    } catch (_e) {
      /* surfaced on next poll */
    }
  };
  card.appendChild(btn);
  return card;
}

function definitionPanel() {
  const panel = el("div", "defpanel");
  if (state.definition) {
    const holder = el("div");
    holder.innerHTML = markdownToHtml(state.definition);
    panel.appendChild(holder);
  } else {
    panel.appendChild(el("div", "def-empty", "The definition file has not been written yet."));
  }
  return panel;
}

// ── boot ─────────────────────────────────────────────────────────────────────

render();
refresh();

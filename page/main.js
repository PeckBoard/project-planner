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

const THINKING_LINES = [
  "Reading your answer…",
  "Writing the requirement into the definition…",
  "Looking through the pending questions…",
  "Choosing the next question…",
];
let thinkingTick = 0;

function schedulePoll() {
  clearTimeout(pollTimer);
  const ms = state && state.status === "thinking" ? POLL_THINKING_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(refresh, ms);
}

async function refresh() {
  try {
    const next = await getJSON(P + "/state");
    const slideChanged =
      (next.slide ? next.slide.slide_no : -1) !== (state && state.slide ? state.slide.slide_no : -1);
    const statusChanged = !state || state.status !== next.status;
    state = next;
    if (statusChanged || slideChanged || state.status === "thinking") render();
  } catch (e) {
    state = { status: "bridge-error", error: e.message };
    render();
  }
  schedulePoll();
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
    case "idle":
      inner.appendChild(startScreen());
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
  bar.appendChild(el("div", "topbar-spacer"));
  if (state && state.definition_exists) {
    bar.appendChild(el("span", "file-chip", state.definition_file || "PROJECT_DEFINITION.md"));
    const toggle = el("button", "ghost-btn", showDefinition ? "Hide definition" : "View definition");
    toggle.onclick = () => {
      showDefinition = !showDefinition;
      render();
    };
    bar.appendChild(toggle);
  }
  if (state && (state.status === "waiting" || state.status === "thinking" || state.status === "failed")) {
    const stop = el("button", "ghost-btn", "Start over");
    stop.onclick = async () => {
      try {
        await postJSON(P + "/reset");
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

  const err = el("div", "error-box");
  err.style.display = "none";
  card.appendChild(err);

  const btn = el("button", "primary-btn", "Begin the interview");
  btn.disabled = !models.length;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      await postJSON(P + "/start", { model: select.value });
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

function thinkingScreen() {
  const card = el("div", "card center");
  const dots = el("div", "dots");
  for (let i = 0; i < 3; i++) dots.appendChild(el("i"));
  card.appendChild(dots);
  thinkingTick = (thinkingTick + 1) % THINKING_LINES.length;
  card.appendChild(el("div", "thinking-line", THINKING_LINES[thinkingTick]));
  if (state.last_note) {
    card.appendChild(el("div", "last-note", "✓ " + state.last_note));
  }
  return card;
}

function slideScreen() {
  const s = state.slide;
  chosenGuard(s);
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
      if (i < parts.length - 1) q.appendChild(el("span", "blank", " "));
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
    input.oninput = () => {
      otherText = input.value;
      syncSubmit();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !submit.disabled) submit.onclick();
    };
    card.appendChild(input);
    setTimeout(() => input.focus(), 50);
    getAnswer = () => otherText.trim();
  }

  card.appendChild(err);

  const actions = el("div", "actions");
  const submit = el("button", "primary-btn", "Submit answer");
  submit.disabled = true;
  submit.onclick = async () => {
    if (submitting) return;
    submitting = true;
    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      await postJSON(P + "/answer", { answer: getAnswer() });
      chosen = new Set();
      otherText = "";
      await refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = "";
      submit.textContent = "Submit answer";
      submit.disabled = false;
    } finally {
      submitting = false;
    }
  };
  actions.appendChild(submit);
  actions.appendChild(
    el(
      "span",
      "action-hint",
      s.kind === "choice" ? (s.multi ? "Pick one or more" : "Pick one") : "Fill in the blank",
    ),
  );
  card.appendChild(actions);

  function syncSubmit() {
    submit.disabled = !getAnswer();
  }
  return card;
}

/** Reset selection state when a new slide arrives. */
function chosenGuard(slide) {
  if (lastSlideNo !== slide.slide_no) {
    lastSlideNo = slide.slide_no;
    chosen = new Set();
    otherText = "";
  }
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
  const btn = el("button", "option" + (slide.multi ? " multi-mark" : ""));
  btn.type = "button";
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
      await postJSON(P + "/reset");
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
      await postJSON(P + "/reset");
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

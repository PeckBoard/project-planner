// Slideshow stylesheet, injected by main.js. Two themes via
// html[data-theme]; the host passes ?theme=light|dark and main.js stamps it.

export const CSS = `
:root {
  --bg: #f4f2fb;
  --bg-aura-a: rgba(124, 92, 255, 0.16);
  --bg-aura-b: rgba(56, 189, 248, 0.14);
  --surface: #ffffff;
  --surface-2: #f7f6fc;
  --text: #1c1a27;
  --text-2: #5b5870;
  --text-3: #8b88a3;
  --border: #e4e1f0;
  --accent: #6d4aff;
  --accent-2: #38bdf8;
  --accent-soft: rgba(109, 74, 255, 0.10);
  --accent-ring: rgba(109, 74, 255, 0.35);
  --danger: #d64545;
  --ok: #2ea06c;
  --shadow: 0 18px 50px rgba(28, 26, 39, 0.10), 0 2px 8px rgba(28, 26, 39, 0.06);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
html[data-theme="dark"] {
  --bg: #12111a;
  --bg-aura-a: rgba(124, 92, 255, 0.18);
  --bg-aura-b: rgba(56, 189, 248, 0.10);
  --surface: #1b1926;
  --surface-2: #221f30;
  --text: #efedf8;
  --text-2: #aaa7c2;
  --text-3: #767390;
  --border: #2e2b40;
  --accent: #8f75ff;
  --accent-2: #4cc6f7;
  --accent-soft: rgba(143, 117, 255, 0.14);
  --accent-ring: rgba(143, 117, 255, 0.45);
  --danger: #ff7a7a;
  --ok: #4cc38a;
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.35);
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background:
    radial-gradient(720px 420px at 12% -10%, var(--bg-aura-a), transparent 60%),
    radial-gradient(640px 420px at 105% 8%, var(--bg-aura-b), transparent 55%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
}

.stage {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 34px 20px 48px;
}
.stage-inner { width: 100%; max-width: 760px; }

/* ── top bar ─────────────────────────────────────────────────────────── */
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.brand-icon {
  width: 30px; height: 30px;
  display: grid; place-items: center;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 4px 14px var(--accent-ring);
}
.brand-icon svg { width: 17px; height: 17px; }
.topbar-spacer { flex: 1; }
.file-chip {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
}
.ghost-btn {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: color .15s, border-color .15s;
}
.ghost-btn:hover { color: var(--text); border-color: var(--accent); }

/* ── progress trail ──────────────────────────────────────────────────── */
.trail {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 18px;
  min-height: 24px;
}
.trail-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  opacity: 0.9;
}
.trail-dot.current {
  width: 22px;
  border-radius: 999px;
  animation: pulse 1.6s ease-in-out infinite;
}
.trail-label {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 6px;
}
@keyframes pulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }

/* ── slide card ──────────────────────────────────────────────────────── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: var(--shadow);
  padding: 30px 34px 28px;
  animation: enter .38s cubic-bezier(.2,.8,.25,1);
}
@keyframes enter {
  from { opacity: 0; transform: translateY(16px) scale(.985); }
  to { opacity: 1; transform: none; }
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.topic-chip {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-radius: 999px;
  padding: 4px 12px;
}
.slide-no { font-size: 12px; color: var(--text-3); }
.queue-badge {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
}

.question {
  font-size: 24px;
  line-height: 1.35;
  font-weight: 650;
  margin: 0 0 14px;
  letter-spacing: -0.01em;
}
.question .blank {
  display: inline-block;
  min-width: 110px;
  border-bottom: 2px dashed var(--accent);
  color: var(--accent);
  text-align: center;
  font-family: var(--mono);
  font-size: 18px;
}

.why {
  display: flex;
  gap: 10px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 0 12px 12px 0;
  padding: 11px 14px;
  margin-bottom: 20px;
  color: var(--text-2);
  font-size: 13.5px;
}
.why b { color: var(--text); font-weight: 650; }

/* ── diagram ─────────────────────────────────────────────────────────── */
.diagram {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 20px;
  overflow: auto;
}
.diagram svg { max-width: 100%; }
.diagram pre {
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text-2);
  white-space: pre;
}
.diagram-caption {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 8px;
  text-transform: uppercase;
  letter-spacing: .06em;
}

/* ── options ─────────────────────────────────────────────────────────── */
.options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.option {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  text-align: left;
  width: 100%;
  background: var(--surface-2);
  border: 1.5px solid var(--border);
  border-radius: 14px;
  padding: 13px 16px;
  cursor: pointer;
  color: var(--text);
  font: inherit;
  transition: border-color .15s, transform .15s, box-shadow .15s;
}
.option:hover { border-color: var(--accent); transform: translateY(-1px); }
.option.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
  background: var(--accent-soft);
}
.option-mark {
  flex: none;
  width: 20px; height: 20px;
  margin-top: 1px;
  border: 2px solid var(--text-3);
  border-radius: 50%;
  display: grid; place-items: center;
  color: transparent;
  transition: all .15s;
}
.option.multi-mark .option-mark { border-radius: 6px; }
.option.selected .option-mark {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.option-mark svg { width: 12px; height: 12px; }
.option-body { min-width: 0; }
.option-label { font-weight: 650; margin-bottom: 2px; }
.option-detail { font-size: 13px; color: var(--text-2); }
.option-input {
  width: 100%;
  margin-top: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 9px;
  padding: 8px 11px;
  font: inherit;
  font-size: 14px;
}
.option-input:focus { outline: 2px solid var(--accent-ring); border-color: var(--accent); }

.fill-input {
  width: 100%;
  font-size: 17px;
  padding: 13px 16px;
  border: 1.5px solid var(--border);
  border-radius: 14px;
  background: var(--surface-2);
  color: var(--text);
  margin-bottom: 20px;
  font-family: inherit;
}
.fill-input:focus { outline: 3px solid var(--accent-ring); border-color: var(--accent); }

/* ── actions ─────────────────────────────────────────────────────────── */
.actions { display: flex; align-items: center; gap: 14px; }
.primary-btn {
  border: 0;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-radius: 999px;
  padding: 11px 26px;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
  box-shadow: 0 6px 18px var(--accent-ring);
  transition: transform .15s, filter .15s;
}
.primary-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); }
.primary-btn:disabled { opacity: .45; cursor: default; box-shadow: none; }
.action-hint { font-size: 12.5px; color: var(--text-3); }

/* ── thinking / start / done / error ─────────────────────────────────── */
.center { text-align: center; padding: 26px 10px 16px; }
.hero-icon {
  width: 62px; height: 62px;
  margin: 0 auto 18px;
  display: grid; place-items: center;
  border-radius: 18px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 10px 30px var(--accent-ring);
}
.hero-icon svg { width: 30px; height: 30px; }
.center h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -0.01em; }
.center p.copy { color: var(--text-2); max-width: 480px; margin: 0 auto 20px; }
.notice {
  display: inline-block;
  font-size: 13px;
  color: var(--text-2);
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 14px;
  margin-bottom: 20px;
}
.model-row {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-bottom: 22px;
}
.model-select {
  min-width: 260px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1.5px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
}

.dots { display: inline-flex; gap: 7px; margin: 8px 0 14px; }
.dots i {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  animation: bounce 1.2s ease-in-out infinite;
}
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 0%,100% { transform: translateY(0); opacity: .5; } 50% { transform: translateY(-7px); opacity: 1; } }
.thinking-line { color: var(--text-2); font-size: 14px; min-height: 22px; }
.last-note {
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--ok);
}

.error-box {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: 12px;
  padding: 12px 16px;
  margin: 0 0 18px;
  font-size: 13.5px;
  text-align: left;
}

/* ── definition preview ──────────────────────────────────────────────── */
.defpanel {
  margin-top: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 22px 26px;
  animation: enter .3s ease;
  text-align: left;
}
.defpanel h1, .defpanel h2, .defpanel h3 { margin: 14px 0 6px; line-height: 1.3; }
.defpanel h1 { font-size: 20px; }
.defpanel h2 { font-size: 16px; color: var(--accent); }
.defpanel h3 { font-size: 14px; }
.defpanel p, .defpanel li { color: var(--text-2); font-size: 13.5px; margin: 4px 0; }
.defpanel ul { margin: 4px 0; padding-left: 20px; }
.defpanel code {
  font-family: var(--mono);
  font-size: 12.5px;
  background: var(--surface-2);
  border-radius: 5px;
  padding: 1px 5px;
}
.def-empty { color: var(--text-3); font-size: 13px; }

.summary {
  font-size: 15px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px 20px;
  max-width: 540px;
  margin: 0 auto 20px;
  text-align: left;
}

@media (max-width: 560px) {
  .card { padding: 22px 18px; }
  .question { font-size: 20px; }
}

/* ── code-derived proposal ────────────────────────────────────── */
.proposal {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1.5px solid var(--ok);
  background: color-mix(in srgb, var(--ok) 7%, transparent);
  border-radius: 14px;
  padding: 13px 16px;
  margin-bottom: 18px;
}
.proposal-chip {
  flex: none;
  align-self: flex-start;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: #fff;
  background: var(--ok);
  border-radius: 999px;
  padding: 3px 10px;
}
.proposal-body { flex: 1; min-width: 0; }
.proposal-answer { font-weight: 650; }
.proposal-evidence {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 2px;
}
.proposal-confirm {
  flex: none;
  padding: 9px 20px;
  background: var(--ok);
  box-shadow: none;
}
@media (max-width: 560px) {
  .proposal { flex-wrap: wrap; }
  .proposal-chip { order: -1; }
}
/* ── repo picker ─────────────────────────────────────────────── */
.repo-chip {
  margin-left: 10px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.repo-list { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.repo-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1.5px solid var(--border);
  border-radius: 14px;
  padding: 14px 18px;
  cursor: pointer;
  transition: border-color .15s, transform .15s;
}
.repo-row:hover { border-color: var(--accent); transform: translateY(-1px); }
.repo-row-body { flex: 1; min-width: 0; }
.repo-row-name { font-weight: 650; display: flex; align-items: center; gap: 8px; }
.repo-branch {
  font-size: 11px;
  font-family: var(--mono);
  font-weight: 500;
  color: var(--accent);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.repo-row-meta {
  font-size: 12.5px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo-row-go { flex: none; font-size: 20px; color: var(--text-3); }
`;

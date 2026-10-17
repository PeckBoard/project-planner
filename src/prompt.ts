// The planner session's contract (system prompt) and the per-turn prompts.
// Pure — unit-testable without an Extism runtime.
//
// Tuning notes, mirrored from the plugin README: the session must stay SMALL
// and the interview fast. The agent publishes a BATCH of mutually independent
// slides; the user answers them all with no agent run in between; then ONE
// record turn (full context — fold every answer into its section file, end
// the turn) and, after the session's context is wiped, a fresh ask turn for
// the next batch. The definition is SPLIT (see sections.ts): every prompt
// carries only the small root index, plus — on a record turn — the sections
// the answers belong to. Other sections are fetched on demand with
// project_planner_read_section. The questions the agent produces must each
// stand alone, because the user sees one slide at a time with no transcript
// around it.

import { DEFINITION_FILE, OVERVIEW, SECTIONS, SECTIONS_DIR, rootPath, sectionPath, sectionTitle } from "./sections";

export { DEFINITION_FILE };

/** Most slides one project_planner_ask call may publish. */
export const MAX_BATCH = 10;

const SECTION_LIST = [
  `${OVERVIEW} (Purpose, Goals — lives in ${DEFINITION_FILE} itself)`,
  ...SECTIONS.map((s) => `${s.id} (${s.title})`),
].join(", ");

export const SYSTEM_PROMPT = `You are the Project Planner: an interviewer that builds the project definition for ONE git repository, one batch of independent questions at a time. The kickoff message names the repo (a path inside this folder — a folder can hold several repos); everything you do — code checks, the definition files, the questions — stays scoped to that repo.

How the definition is stored: it is SPLIT into files so nobody has to read all of it at once. ${DEFINITION_FILE} at the repo root holds the overview (Purpose and Goals) plus an index that links one file per section under ${SECTIONS_DIR}/, each with a one-line summary. Every section file depends on ${DEFINITION_FILE}: it opens with a header pointing back at it and must never contradict its Purpose and Goals. Sections: ${SECTION_LIST}. The plugin writes the index and the section headers for you — you write one section's body at a time.

How you talk to the user: ONLY through the project_planner_ask tool. The user sees a slideshow, not this chat — text you write outside tools reaches nobody. One call publishes a BATCH of 1 to ${MAX_BATCH} slides, each with exactly one question; the user answers them one after another, and all the answers arrive together as the next message. After calling it, end your turn and wait.

Order of business:
1. If the overview does not yet state the project's PURPOSE and GOAL, your first questions establish them. Until purpose and goal are written down, do NOT ask about architecture, tools, libraries, databases, languages, deployment, monitoring, user flows, or user stories — those questions only make sense against a known purpose.
2. Once purpose and goal are recorded, work outward: users and their stories (grounded in that purpose and goal), then the flows those stories need, then architecture, technology choices (with comparisons), deployment, and monitoring.
3. When everything above is pinned down and the pending queue is empty, call project_planner_finish.

How to batch:
- Fill each batch with every question you can usefully ask right now, up to ${MAX_BATCH} — fewer turns make the interview faster.
- Every question in a batch must make sense WHATEVER the user answers to the other questions of the same batch. Never batch a follow-up to another question of the same batch. Example: if one slide asks "Do you want X, Y, or both?", a slide asking "What should X do?" must NOT share its batch — the user may pick only Y. Queue that follow-up with project_planner_queue; a later batch asks it only if the answer shows it still applies.
- A topic-choice slide always goes alone in its batch: every later question depends on the topic picked.
- The queue holds follow-ups whose prerequisite is not answered yet. When building a batch, drop queue entries the answers have made moot, pull in every entry whose prerequisite is now answered (set the slide's from_queue to the exact entry — it leaves the queue when the batch is published), and leave queued whatever still depends on an open question.

How to ask:
- Pointed, never broad. "Which database holds the orders?" not "Tell me about your data layer."
- Simple language, short sentences, no lists inside the question text.
- Each slide must be understandable in a vacuum: the 'why' field carries the one or two sentences of context that justify the problem — a reader who saw nothing else must still understand what is being decided and why it matters.
- Every slide names the ONE section its answer will be recorded in (the 'section' field).
- kind "choice": 2 to 5 options, each with a one-sentence justification naming its trade-off, so the options compare against each other. Set multi:true only when several can genuinely be picked together.
- kind "fill": phrase the sentence with ___ for the blank and give blank_hint as a realistic example.
- Attach a small mermaid diagram (flowchart or sequence, at most ~12 nodes) when a picture describes the problem or the compared options better than words. Skip it otherwise.
- If a topic is too complex for one pointed question, split it into independent questions for this batch, and queue the parts that depend on their answers.

Reading sections: the index summaries are usually enough to pick the next questions. Call project_planner_read_section for a section only when a question you are about to ask depends on its details — never read every section.

Check the code before asking:
- If the folder already contains code, first take a SHORT, targeted look (list files, read a manifest like package.json / Cargo.toml / go.mod, one search) to see whether the code already answers the questions you are about to ask.
- When it does, still show the slide — but pass proposed_answer (the conclusion the code supports) and evidence (one plain sentence naming where the code shows it, e.g. "Cargo.toml declares Axum with Diesel/SQLite"). The user then confirms with one click or corrects you; never treat the code's answer as final without their confirmation.
- Only propose what the code actually shows — a guess is not a finding. If the code is silent on the question, ask normally with no proposal.
- Keep these checks cheap: a few targeted reads per batch, never a deep exploration.

After every batch is answered — two steps, two separate turns:
1. RECORD (the turn that delivers the batch's answers, with the current content of every section they name): for each of those sections call project_planner_write_definition ONCE with the section id, its COMPLETE updated body, and a one-line summary of the whole section for the index — for each answer write ONE new requirement, or amend the one existing requirement it changes; keep the rest of the section intact. Requirements are short declarative sentences, each with its justification. If an answer belongs in a different section than its slide named, read that one first and write it there. Update the queue via project_planner_queue: add follow-ups the answers opened, remove entries they made moot. Then END YOUR TURN — do NOT call project_planner_ask in this turn; the interview continues after your context is reset.
2. ASK (a fresh turn after the reset): a new message carrying the current index and queue tells you to continue — publish the next batch via project_planner_ask, or call project_planner_finish when everything is covered and the queue is empty.

Keep yourself small: your chat history is wiped after each batch is recorded, and the index and queue arrive with every message — so never read the definition files from disk with other tools, never rely on remembering earlier turns, and keep any code checks to the short, targeted reads described above. Do not summarize progress in chat. Never ask the user anything through any other mechanism.`;

function queuePart(pending: string[], label = "Pending queue"): string {
  return pending.length ? `${label}:\n${pending.map((q) => `- ${q}`).join("\n")}` : `${label}: empty.`;
}

function indexPart(repo: string, index: string | null): string {
  return index
    ? `Current ${rootPath(repo)} — the overview and section index (between markers):\n<<<INDEX\n${index}\nINDEX>>>`
    : `${rootPath(repo)} does not exist yet — seed it via project_planner_write_definition with section "${OVERVIEW}" (a title plus empty Purpose and Goals headings).`;
}

/** First dispatch of a run, scoped to one repo. `index` is the root file's
 * content (already split), or null when none exists yet. `topic` is an
 * optional user-chosen starting topic steering where the interview digs
 * first; when absent, the kickoff instructs the agent to open with a
 * topic-choice slide whose options it generates from the index. */
export function kickoffPrompt(
  repo: string,
  index: string | null,
  pending: string[],
  topic?: string | null,
): string {
  const where =
    repo === "."
      ? "This folder's root IS the git repo you are planning."
      : `The git repo you are planning lives at '${repo}' inside this folder — the folder holds more than this repo, so keep every code check inside '${repo}/' and ignore the rest.`;
  const defPart = index
    ? `${indexPart(repo, index)}\nContinue from it: fill gaps and firm up vague requirements instead of re-asking what it already answers. Read a section with project_planner_read_section only when a question needs its details.`
    : `The repo has no ${rootPath(repo)} yet. First call project_planner_write_definition with section "${OVERVIEW}" to seed the skeleton (a title plus empty Purpose and Goals headings), then ask your first question — the project's purpose. (The tool writes the files into the repo for you — never write them by any other means.)`;
  const topicPart = topic
    ? `The user chose a starting topic for this interview: "${topic}". Steer there: once purpose and goal are on record (capture them first, briefly, if the overview still lacks them), focus your questions on this topic and stay on it until it is pinned down before moving on to anything else.`
    : `No starting topic was chosen, so ask for one: once purpose and goal are on record (capture them first, briefly, if the overview still lacks them), your next slide is a topic slide — kind "choice", section "${OVERVIEW}", asking which topic this pass should dig into. Generate 3 to 5 candidate topics from the definition index and what the code shows: sections not written yet or with thin summaries, the Open Questions section, stated goals with no requirements behind them. Topics are short product areas — the flavor of "game rules", "game mechanics", "user controls", "permission system", "authentication system", "site branding" — but generate ones that fit THIS project, not those examples. Each option's justification says why that area needs pinning down now; the slide's free-text option already lets the user type a different topic instead. Then steer to the chosen topic: focus your questions on it and stay on it until it is pinned down before moving on to anything else.`;
  return [
    where,
    defPart,
    pending.length
      ? queuePart(pending, "Pending question queue from a previous run")
      : "The pending question queue is empty.",
    topicPart,
    "Begin the interview now: one batch of independent, pointed questions via project_planner_ask.",
  ].join("\n\n");
}

/** One answered slide of the batch being recorded. */
export interface BatchAnswer {
  question: string;
  answer: string;
  /** The section the slide named; null for slides from an older version. */
  section: string | null;
}

/** The RECORD turn: dispatched (with full context) once the user has
 * answered EVERY slide of the batch. Carries the index plus ONLY the sections
 * those slides named. Write them, then stop — the next batch is asked
 * separately, after the context wipe. */
export function recordPrompt(args: {
  repo: string;
  answers: BatchAnswer[];
  /** Current content of each non-overview section the answers name. */
  sections: Record<string, string | null>;
  index: string | null;
  pending: string[];
}): string {
  const qa = args.answers
    .map(
      (a, i) =>
        `${i + 1}. [section: ${a.section ?? "unnamed — pick the one it belongs in"}]\n` +
        `   Question: ${a.question}\n   Answer: ${a.answer}`,
    )
    .join("\n");
  const named = [...new Set(args.answers.map((a) => a.section).filter((s): s is string => !!s))];
  const sectionParts = named.map((id) => {
    if (id === OVERVIEW) {
      return `Section "${OVERVIEW}" is the overview above (the index part is regenerated for you).`;
    }
    const path = sectionPath(args.repo, id);
    const content = args.sections[id];
    return content
      ? `Section "${id}" (${sectionTitle(id)}). Current ${path} (between markers):\n<<<SECTION\n${content}\nSECTION>>>`
      : `Section "${id}" (${sectionTitle(id)}) — ${path} does not exist yet; your write creates it.`;
  });
  if (args.answers.some((a) => !a.section)) {
    sectionParts.push(
      `An answer above names no section: pick the one it belongs in, read it with ` +
        `project_planner_read_section, then write it.`,
    );
  }
  const n = args.answers.length;
  return (
    `The user answered ${n === 1 ? "the slide" : `all ${n} slides of the batch`}:\n${qa}\n\n` +
    `${indexPart(args.repo, args.index)}\n\n${sectionParts.join("\n\n")}\n\n${queuePart(args.pending)}\n\n` +
    `Now record them: (1) for EACH section above call project_planner_write_definition ONCE, with ` +
    `the section id, its COMPLETE updated body, and a one-line summary of the whole section — ` +
    `folding in every answer that belongs there, one new or amended requirement per answer; ` +
    `(2) update the pending queue via project_planner_queue: add follow-ups these answers opened, ` +
    `and remove entries they made moot (e.g. a queued "what should X do" when the user did not ` +
    `pick X). Then END YOUR TURN. Do NOT call project_planner_ask — your context is reset after ` +
    `this turn, and the next message will tell you to ask the next batch.`
  );
}

/** The ASK turn: dispatched onto the freshly wiped session once the record
 * turn has landed. Carries the index and queue — not the section bodies. */
export function askNextPrompt(args: { repo: string; index: string | null; pending: string[] }): string {
  return (
    `(Your chat history was reset — this message carries the complete interview state; nothing ` +
    `earlier is coming back.)\n\n` +
    `${indexPart(args.repo, args.index)}\n\n${queuePart(args.pending)}\n\n` +
    `Continue the interview with ONE batch of up to ${MAX_BATCH} independent questions. Drop queue ` +
    `entries the definition has made moot; pull in every queue entry whose prerequisite is now ` +
    `answered (set from_queue to the exact entry); add the most valuable questions for the index's ` +
    `gaps (sections not written yet, thin summaries). Before publishing, check every pair: if one ` +
    `question only makes sense for some answers of another in the batch, take it out and queue it ` +
    `instead. Read a section with project_planner_read_section only if a question depends on its ` +
    `details, check the code briefly if it can answer what you are about to ask, then publish the ` +
    `batch via project_planner_ask — or, if everything is covered and the queue is empty, call ` +
    `project_planner_finish.`
  );
}
export function stalledPrompt(): string {
  return (
    "Your last run ended without showing the user a slide. Remember: the user only sees what " +
    "project_planner_ask shows. Ask the next question now (or call project_planner_finish if " +
    "the definition is complete)."
  );
}

/** Nudge when a record turn ended without writing the definition. */
export function recordStalledPrompt(): string {
  return (
    "Your last run ended without recording the user's answers. For each section they belong " +
    "in, call project_planner_write_definition now with the section id and that section's " +
    "COMPLETE updated body — fold each answer you were given into it as one new or amended " +
    "requirement — then end your turn."
  );
}

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, askNextPrompt, kickoffPrompt, recordPrompt } from "../src/prompt";

describe("planner contract", () => {
  it("forbids specialist questions before purpose and goal are known", () => {
    expect(SYSTEM_PROMPT).toMatch(/do NOT ask about architecture/i);
    expect(SYSTEM_PROMPT).toContain("PURPOSE");
    expect(SYSTEM_PROMPT).toContain("GOAL");
  });

  it("pins the one-slide, tool-only interaction model", () => {
    expect(SYSTEM_PROMPT).toContain("project_planner_ask");
    expect(SYSTEM_PROMPT).toMatch(/one question at a time|one slide/i);
    expect(SYSTEM_PROMPT).toMatch(/understandable in a vacuum/);
  });


  it("tells the agent to check existing code and propose, never presume", () => {
    expect(SYSTEM_PROMPT).toContain("proposed_answer");
    expect(SYSTEM_PROMPT).toMatch(/code already answers/i);
    expect(SYSTEM_PROMPT).toMatch(/never treat the code's answer as final/i);
  });
  it("requires a definition write after every answer", () => {
    expect(SYSTEM_PROMPT).toContain("project_planner_write_definition");
    expect(SYSTEM_PROMPT).toMatch(/After every answer/);
    expect(SYSTEM_PROMPT).toMatch(/ONE new requirement|one requirement/i);
  });

  it("kickoff embeds the repo scope, an existing definition, and the queue", () => {
    const p = kickoffPrompt("apps/web", "# My Project\nGoal: ship.", ["Which DB?"]);
    expect(p).toContain("'apps/web'");
    expect(p).toMatch(/keep every code check inside 'apps\/web\/'/);
    expect(p).toContain("# My Project");
    expect(p).toContain("Which DB?");
    expect(p).toMatch(/Continue from it/);
  });

  it("kickoff without a definition asks to seed the skeleton first", () => {
    const p = kickoffPrompt(".", null, []);
    expect(p).toMatch(/folder's root IS the git repo/);
    expect(p).toMatch(/seed the skeleton/);
    expect(p).toMatch(/queue is empty/);
  });

  it("kickoff with a starting topic steers the interview there", () => {
    const p = kickoffPrompt(".", null, [], "game rules");
    expect(p).toContain('starting topic for this interview: "game rules"');
    expect(p).toMatch(/focus your questions on this topic/);
    expect(p).not.toContain("topic slide");
  });

  it("kickoff without a topic asks for one via a generated topic-choice slide", () => {
    const p = kickoffPrompt(".", null, []);
    expect(p).toMatch(/No starting topic was chosen, so ask for one/);
    expect(p).toMatch(/topic slide — kind "choice"/);
    expect(p).toMatch(/Generate 3 to 5 candidate topics from the definition/);
    expect(p).toMatch(/type a different topic/);
  });
  it("record prompt carries the Q&A, the index, ONLY the named section, and forbids asking", () => {
    const p = recordPrompt({
      repo: "apps/web",
      question: "What is the goal?",
      answer: "Sell hats",
      section: "technology",
      sectionContent: "# Technology\n- Rust",
      index: "# Def",
      pending: ["Who wears them?"],
    });
    expect(p).toContain("What is the goal?");
    expect(p).toContain("Sell hats");
    expect(p).toContain("# Def");
    expect(p).toContain("- Rust");
    expect(p).toContain("apps/web/project-definition/technology.md");
    expect(p).toContain("Who wears them?");
    // The record turn runs WITH context and must stop after the write — the
    // next question is asked from a wiped session in a separate turn.
    expect(p).toContain("project_planner_write_definition");
    expect(p).toMatch(/Do NOT call project_planner_ask/);
    expect(p).not.toMatch(/chat history was reset/);
  });

  it("ask prompt carries the index and announces the reset", () => {
    const p = askNextPrompt({ repo: ".", index: "# Def", pending: ["Who wears them?"] });
    expect(p).toContain("# Def");
    expect(p).toContain("Who wears them?");
    expect(p).toContain("project_planner_ask");
    expect(p).toContain("project_planner_read_section");
    // The session is wiped before this dispatch lands — the prompt must say
    // so, or the model hunts for turns that no longer exist.
    expect(p).toMatch(/chat history was reset/);
  });

  it("contract explains the split layout and that sections depend on the root", () => {
    expect(SYSTEM_PROMPT).toContain("project-definition/");
    expect(SYSTEM_PROMPT).toMatch(/depends on PROJECT_DEFINITION\.md/);
    expect(SYSTEM_PROMPT).toMatch(/never read every section/);
  });
});

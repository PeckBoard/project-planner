import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, answerPrompt, kickoffPrompt } from "../src/prompt";

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
  });

  it("kickoff without a topic carries no steer paragraph", () => {
    const p = kickoffPrompt(".", null, []);
    expect(p).not.toContain("starting topic");
  });

  it("answer prompt carries question, answer, definition, and queue", () => {
    const p = answerPrompt({
      question: "What is the goal?",
      answer: "Sell hats",
      definition: "# Def",
      pending: ["Who wears them?"],
    });
    expect(p).toContain("What is the goal?");
    expect(p).toContain("Sell hats");
    expect(p).toContain("# Def");
    expect(p).toContain("Who wears them?");
  });
});

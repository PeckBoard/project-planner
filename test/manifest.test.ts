import { describe, expect, it } from "vitest";
import { manifestJson } from "../src/manifest";

const manifest = JSON.parse(manifestJson());

describe("manifest", () => {
  it("carries the required identity fields", () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.repository).toBe("https://github.com/peckboard/project-planner");
  });

  it("declares only hook and route shapes core accepts", () => {
    expect(manifest.hooks).toEqual(
      expect.arrayContaining(["mcp.tool.invoke", "http.request.before", "http.request.authed"]),
    );
    for (const route of manifest.ui_routes) {
      expect(route).toMatch(/^(GET|POST) \/api\/plugin-ui\/project-planner\//);
    }
    expect(manifest.http_routes).toEqual(["GET /plugin-api/v1/project-planner"]);
  });

  it("scopes its page items (never a global sidebar entry)", () => {
    // A global sidebar page carries no x-peckboard-* scope header, so every
    // folder-scoped host call would fail. See the manifest comment.
    expect(manifest.sidebar_items).toBeUndefined();
    for (const kind of ["folder_items", "project_items", "session_items"]) {
      expect(manifest[kind]).toHaveLength(1);
      expect(manifest[kind][0].path).toBe("/plugin-api/v1/project-planner");
    }
  });

  it("names MCP tools within core's charset rule", () => {
    const names = manifest.mcp_tools.map((t: any) => t.name);
    expect(names).toEqual([
      "project_planner_ask",
      "project_planner_queue",
      "project_planner_write_definition",
      "project_planner_finish",
    ]);
    for (const n of names) {
      expect(n).toMatch(/^[a-z0-9_]{1,64}$/);
    }
  });

  it("requires the ask tool's self-contained-slide fields", () => {
    const ask = manifest.mcp_tools.find((t: any) => t.name === "project_planner_ask");
    expect(ask.input_schema.required).toEqual(["topic", "kind", "question", "why"]);
    expect(ask.input_schema.properties.kind.enum).toEqual(["choice", "fill"]);
  });
});

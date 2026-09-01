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

  it("launches ONLY from the repo browser — no folder-level surface", () => {
    // A global sidebar page carries no x-peckboard-* scope header, and
    // folder/project/session buttons would put the planner back at the
    // folder level. The single folder_items entry is repo_scoped: core
    // hides it from folder surfaces and offers it per repo row.
    expect(manifest.sidebar_items).toBeUndefined();
    expect(manifest.project_items).toBeUndefined();
    expect(manifest.session_items).toBeUndefined();
    expect(manifest.folder_items).toHaveLength(1);
    expect(manifest.folder_items[0].repo_scoped).toBe(true);
    expect(manifest.folder_items[0].path).toBe("/plugin-api/v1/project-planner");
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

// The registry compares its version against what the LOADED wasm manifest
// reports. If the manifest lags package.json, every upgrade "succeeds" but
// the upgrade-available chip never clears (happened with 0.3.0).
describe("manifest version source", () => {
  it("matches package.json exactly", async () => {
    const pkg = await import("../package.json");
    expect(manifest.version).toBe(pkg.version);
  });
});

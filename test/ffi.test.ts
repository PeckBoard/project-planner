import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The extism-js compiler only imports host functions declared in
// src/index.d.ts. A host call whose name is missing there compiles fine and
// then throws at runtime inside the wasm — silently, because callers tend to
// swallow it as a graceful degrade. Guard the declaration list against the
// calls actually made in src/.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function declaredHostFns(): Set<string> {
  const dts = readFileSync(path.join(SRC, "index.d.ts"), "utf8");
  const block = dts.match(/declare module "extism:host"[\s\S]*?\{([\s\S]*)\}/);
  const names = new Set<string>();
  for (const m of (block ? block[1] : "").matchAll(/^\s*([A-Za-z0-9_]+)\s*\(/gm)) {
    names.add(m[1]);
  }
  return names;
}

function calledHostFns(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const src = readFileSync(path.join(SRC, file), "utf8");
    for (const m of src.matchAll(/hostCall\(\s*"([A-Za-z0-9_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

describe("wasm FFI declarations", () => {
  it("declares every host function the plugin calls", () => {
    const declared = declaredHostFns();
    const called = calledHostFns();
    expect(called.size).toBeGreaterThan(0);
    const missing = [...called].filter((n) => !declared.has(n));
    expect(missing, `undeclared in src/index.d.ts: ${missing.join(", ")}`).toEqual([]);
  });
});

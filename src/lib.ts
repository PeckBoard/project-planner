// Hook + tool dispatch. Parses the `{ hook, payload }` envelope and routes each
// call to its handler. The wasm export functions live in `index.ts`.

import { skip, allow, cancel, errMsg } from "./verdict";
import { serveHttp, serveAuthed } from "./http";
import { toolAsk, toolFinish, toolQueue, toolWriteDefinition } from "./planner";

/// The agent-facing tools, keyed by the name declared in the manifest. Each
/// takes the caller `context` as its second argument — core builds it from the
/// verified ToolCallContext, so the planner-session guard cannot be forged.
const TOOLS: Record<string, (args: any, context: any) => any> = {
  project_planner_ask: toolAsk,
  project_planner_queue: toolQueue,
  project_planner_write_definition: toolWriteDefinition,
  project_planner_finish: toolFinish,
};

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    default:
      return skip();
  }
}

function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const args = payload.arguments ?? {};
  const context = payload.context ?? {};

  const fn = TOOLS[tool];
  if (!fn) {
    return cancel(`project-planner does not provide tool '${tool}'`);
  }
  try {
    return allow(fn(args, context));
  } catch (e) {
    // A handler error is a normal tool result (the agent sees the message and
    // can correct itself), not a plugin cancel.
    return allow({ error: errMsg(e) });
  }
}

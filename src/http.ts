// HTTP surfaces: the served slideshow page (`http.request.before`) and the
// authenticated app-UI endpoints (`http.request.authed`) it drives the
// interview through. The page is sandboxed with no same-origin access — it
// goes through the standard parent-proxied fetch bridge — so these routes are
// the whole contract between the two halves of the plugin.

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import { answer, pageState, requireFolder, reset, start } from "./planner";

const PAGE_PATH = "/plugin-api/v1/project-planner";
const API = "/api/plugin-ui/project-planner";

function up(v: unknown): string {
  return (typeof v === "string" ? v : "").toUpperCase();
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function parseBody(body: string): any {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("invalid request body: " + errMsg(e));
  }
}

/// Serve the slideshow page (a folder, project, or session item opens this).
export function serveHttp(payload: any): string {
  if (up(payload?.method) === "GET" && str(payload?.path) === PAGE_PATH) {
    return htmlResponse(200, PAGE);
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}

/// Authenticated app-UI endpoints under /api/plugin-ui/project-planner/*.
export function serveAuthed(payload: any): string {
  const method = up(payload?.method);
  const path = str(payload?.path);
  const body = str(payload?.body);

  try {
    const folderId = requireFolder();
    if (method === "GET" && path === `${API}/state`) {
      return jsonResponse(200, pageState(folderId));
    }
    if (method === "POST" && path === `${API}/start`) {
      const b = parseBody(body);
      return jsonResponse(200, start(folderId, str(b?.model)));
    }
    if (method === "POST" && path === `${API}/answer`) {
      const b = parseBody(body);
      return jsonResponse(200, answer(folderId, str(b?.answer)));
    }
    if (method === "POST" && path === `${API}/reset`) {
      return jsonResponse(200, reset(folderId));
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

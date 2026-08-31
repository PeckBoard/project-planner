// HTTP surfaces: the served slideshow page (`http.request.before`) and the
// authenticated app-UI endpoints (`http.request.authed`) it drives the
// interview through. The page is sandboxed with no same-origin access — it
// goes through the standard parent-proxied fetch bridge — so these routes are
// the whole contract between the two halves of the plugin. Interviews are
// REPO-scoped: every route (except the repo listing) carries a `repo`,
// the folder-relative path of a git repo ('.' = the folder root).

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import { answer, pageState, repoList, requireFolder, reset, start } from "./planner";

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

/// Extract and URL-decode `name`'s value from a `&`-separated query string.
export function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) !== name) continue;
    const v = pair.slice(idx + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, "%20"));
    } catch (_e) {
      return v;
    }
  }
  return undefined;
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
  const query = str(payload?.query);
  const body = str(payload?.body);

  try {
    const folderId = requireFolder();
    if (method === "GET" && path === `${API}/repos`) {
      return jsonResponse(200, repoList(folderId));
    }
    if (method === "GET" && path === `${API}/state`) {
      return jsonResponse(200, pageState(folderId, queryParam(query, "repo")));
    }
    if (method === "POST" && path === `${API}/start`) {
      const b = parseBody(body);
      return jsonResponse(200, start(folderId, b?.repo, str(b?.model), b?.topic));
    }
    if (method === "POST" && path === `${API}/answer`) {
      const b = parseBody(body);
      return jsonResponse(200, answer(folderId, b?.repo, str(b?.answer)));
    }
    if (method === "POST" && path === `${API}/reset`) {
      const b = parseBody(body);
      return jsonResponse(200, reset(folderId, b?.repo));
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

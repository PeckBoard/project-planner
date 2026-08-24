// FFI layer: the Peckboard core host functions this plugin calls, and the
// host_call marshaling helper. Host calls are kept LAZY (inside functions) so
// the pure modules load under vitest without an Extism runtime.
//
// KEEP IN SYNC with src/index.d.ts — an undeclared host call traps at runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Plugin document store (data_store permission) ────────────────────────────

export function storePut(collection: string, key: string, data: unknown): void {
  hostCall("peckboard_store_put", { collection, key, data });
}

export function storeGet(collection: string, key: string): any {
  const result = hostCall("peckboard_store_get", { collection, key });
  return result?.value ?? null;
}

export function storeDelete(collection: string, key: string): void {
  hostCall("peckboard_store_delete", { collection, key });
}

// ── Caller scope ─────────────────────────────────────────────────────────────

/// The folder/project/session this call is running in, as core resolved it:
/// the verified MCP invocation scope, or the scope of the authenticated page
/// request. `{folder_id: null}` when the plugin is in neither.
export function callerScope(): {
  folder_id: string | null;
  project_id: string | null;
  session_id: string | null;
  authority: boolean;
} {
  return hostCall("peckboard_caller_scope", {});
}

// ── Models (models_read permission) ─────────────────────────────────────────

export interface ModelChoice {
  id: string;
  display_name: string;
  provider: string;
  account_id: string | null;
  thinking: boolean;
  tier: number;
}

export function listModels(): ModelChoice[] {
  const result = hostCall("peckboard_list_models", {});
  return result?.models ?? [];
}

// ── Sessions (session_write / session_dispatch / session_read) ──────────────

export interface CreateSessionInput {
  name: string;
  model: string;
  is_temp: boolean;
  system_prompt?: string;
}

/// Create a session in the CALLER's folder (core pins the scope; a plugin
/// cannot seed a session elsewhere). Returns the created session's id.
export function createSession(input: CreateSessionInput): string {
  const result = hostCall("peckboard_create_session", input);
  const id = result?.session?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("session creation returned no session id");
  }
  return id;
}

export function dispatchCapture(sessionId: string, prompt: string): void {
  hostCall("peckboard_dispatch_capture", { session_id: sessionId, prompt });
}

export interface SessionEventBrief {
  seq: number;
  kind: string;
  name: string | null;
}

/// Slim event tail — `{seq, kind, name}` only, never payloads. The planner
/// only uses it to know whether the agent's run is still going.
export function sessionEvents(
  sessionId: string,
  afterSeq: number,
  limit?: number,
): { events: SessionEventBrief[]; latest_seq: number | null } {
  const input: any = { session_id: sessionId, after_seq: afterSeq };
  if (typeof limit === "number") input.limit = limit;
  const result = hostCall("peckboard_session_events", input);
  return {
    events: result?.events ?? [],
    latest_seq: result?.latest_seq ?? null,
  };
}

/// Whether a session row still exists (a temp session vanishes when its tab
/// is closed) — via the brief listing.
export function sessionExists(sessionId: string): boolean {
  const result = hostCall("peckboard_list_sessions_brief", {});
  const sessions: any[] = result?.sessions ?? [];
  return sessions.some((s) => s && s.session_id === sessionId);
}

/// Replace the planner session's standing instructions (appended after the
/// standing Peckboard prompt; read at every dispatch).
export function setSessionSystemPrompt(sessionId: string, prompt: string): void {
  hostCall("peckboard_set_session_system_prompt", {
    session_id: sessionId,
    system_prompt: prompt,
  });
}

// ── Project files (project_files_read / project_files_write) ────────────────

/// Read one UTF-8 text file under the caller's folder; null when missing.
export function readFileOrNull(path: string): string | null {
  try {
    const result = hostCall("peckboard_read_file", { path });
    return typeof result?.content === "string" ? result.content : null;
  } catch (_e) {
    return null;
  }
}

/// Write one UTF-8 text file under the caller's folder (jailed by core).
export function writeFile(path: string, content: string): void {
  hostCall("peckboard_write_file", { path, content, create_dirs: false });
}

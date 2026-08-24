// Wasm interface for the Extism js-pdk compiler (`extism-js`). Declares the
// plugin's exported functions and the host functions Peckboard core provides.
//
// Host functions are JSON-string-in / JSON-string-out at the application level;
// at the ABI they pass a single Extism memory offset (I64) in and return one
// out. See peckboard/src/plugin/host.rs for the host side.
//
// KEEP IN SYNC with the hostCall("...") sites in src/ — test/ffi.test.ts fails
// the build if a call names a function that isn't declared here. An undeclared
// host call compiles fine and then traps at runtime inside the sandbox.
declare module "main" {
  export function manifest(): I32;
  export function init(): I32;
  export function shutdown(): I32;
  export function handle(): I32;
}

declare module "extism:host" {
  interface user {
    peckboard_store_put(ptr: I64): I64;
    peckboard_store_get(ptr: I64): I64;
    peckboard_store_list(ptr: I64): I64;
    peckboard_store_delete(ptr: I64): I64;
    peckboard_caller_scope(ptr: I64): I64;
    peckboard_list_models(ptr: I64): I64;
    peckboard_create_session(ptr: I64): I64;
    peckboard_dispatch_capture(ptr: I64): I64;
    peckboard_session_events(ptr: I64): I64;
    peckboard_list_sessions_brief(ptr: I64): I64;
    peckboard_set_session_system_prompt(ptr: I64): I64;
    peckboard_read_file(ptr: I64): I64;
    peckboard_write_file(ptr: I64): I64;
  }
}

// A stand-in for the Extism host boundary (same shape as graphify's), so the
// tests can drive real plugin code paths (`Host.getFunctions()` + `Memory`).
// Importing this module installs the fake; each test then declares only the
// host functions it cares about.

const memory = new Map<bigint, string>();
let nextOffset = 1n;

/// Every host call the code under test made, in order.
export const hostCalls: { name: string; input: any }[] = [];

let handlers: Record<string, (input: any) => unknown> = {};

function alloc(text: string): bigint {
  const offset = nextOffset++;
  memory.set(offset, text);
  return offset;
}

(globalThis as any).Memory = {
  fromString: (s: string) => ({ offset: alloc(s) }),
  find: (offset: bigint) => ({ readString: () => memory.get(offset) ?? "" }),
};

(globalThis as any).Host = {
  getFunctions: () =>
    new Proxy(
      {},
      {
        get: (_target, name: string) => (offset: bigint) => {
          const input = JSON.parse(memory.get(offset) ?? "{}");
          hostCalls.push({ name, input });
          return alloc(JSON.stringify(handlers[name] ? handlers[name](input) : {}));
        },
      },
    ),
};

/// Replace the declared host functions and clear the call log.
export function setHandlers(next: Record<string, (input: any) => unknown>): void {
  handlers = next;
  hostCalls.length = 0;
}

/// Host functions for the plugin document store, backed by a plain object.
/// Keys are `<collection>/<key>`.
export function docStore(seed: Record<string, unknown> = {}): {
  docs: Record<string, unknown>;
  handlers: Record<string, (input: any) => unknown>;
} {
  const docs: Record<string, unknown> = { ...seed };
  return {
    docs,
    handlers: {
      peckboard_store_get: ({ collection, key }: any) => ({
        value: docs[`${collection}/${key}`] ?? null,
      }),
      peckboard_store_put: ({ collection, key, data }: any) => {
        docs[`${collection}/${key}`] = data;
        return {};
      },
      peckboard_store_delete: ({ collection, key }: any) => {
        delete docs[`${collection}/${key}`];
        return {};
      },
    },
  };
}

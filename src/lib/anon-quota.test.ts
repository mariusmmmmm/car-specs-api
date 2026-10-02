import { describe, expect, it } from "vitest";
import { ANON_PER_MINUTE, ANON_PER_MONTH, checkAnonRate } from "./anon-quota";

// Minimal in-memory stand-in for the two KVNamespace methods the limiter uses.
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
  };
}

const month = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

describe("anonymous MCP limits", () => {
  it("allows a request and counts it against the minute and the month", async () => {
    const { kv, store } = fakeKv();
    expect(await checkAnonRate(kv, "1.2.3.4")).toEqual({ ok: true });
    expect(store.get(`mcp-anon-m:1.2.3.4:${month()}`)).toBe("1");
  });

  it("refuses an IP that has used up its month, before the minute check", async () => {
    const { kv } = fakeKv({ [`mcp-anon-m:1.2.3.4:${month()}`]: String(ANON_PER_MONTH) });
    expect(await checkAnonRate(kv, "1.2.3.4")).toEqual({ ok: false, reason: "month" });
  });

  it("still applies the per-minute burst limit", async () => {
    const minuteKey = `mcp-anon:5.6.7.8:${Math.floor(Date.now() / 60_000)}`;
    const { kv } = fakeKv({ [minuteKey]: String(ANON_PER_MINUTE) });
    expect(await checkAnonRate(kv, "5.6.7.8")).toEqual({ ok: false, reason: "minute" });
  });

  it("keeps IPs separate", async () => {
    const { kv } = fakeKv({ [`mcp-anon-m:1.2.3.4:${month()}`]: String(ANON_PER_MONTH) });
    expect(await checkAnonRate(kv, "9.9.9.9")).toEqual({ ok: true });
  });

  it("fails open when KV writes fail", async () => {
    const kv = { get: async () => null, put: async () => { throw new Error("429"); } } as unknown as KVNamespace;
    expect(await checkAnonRate(kv, "1.2.3.4")).toEqual({ ok: true });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { encodeId, decodeId, encodeIds, MissingIdSecret, __resetIdKeyCache } from "./public-id";

const SECRET = "test-secret-at-least-16-chars-long";
const OTHER = "a-different-secret-also-long-enough";

beforeEach(() => __resetIdKeyCache());

describe("opaque public ids (T92)", () => {
  it("round-trips every id across the live range and beyond", async () => {
    const ids = [1, 4, 42, 1000, 50_000, 103_099, 115_170, 999_999, 0x7ffffffe];
    for (const id of ids) {
      const token = await encodeId(SECRET, "variant", id);
      expect(await decodeId(SECRET, "variant", token)).toBe(id);
    }
  });

  // A Feistel network is a permutation for ANY round function, so these two do
  // not test the maths — they test THIS implementation (the masking and the
  // inverse). 5.000 ids catch an off-by-one in either just as well as 103.099
  // would, and cost 6 HMACs each: measured 2,63 ms for 50 tokens, so the full
  // catalogue would be ~5 s of pure HMAC in a unit test for no extra signal.
  it("is injective over 5.000 consecutive ids — no collisions", async () => {
    const tokens = await encodeIds(SECRET, "variant", Array.from({ length: 5_000 }, (_, i) => i + 1));
    expect(new Set(tokens).size).toBe(5_000);
  }, 30_000);

  it("the inverse recovers every one of 2.000 consecutive ids", async () => {
    const ids = Array.from({ length: 2_000 }, (_, i) => i + 1);
    const tokens = await encodeIds(SECRET, "variant", ids);
    const back = await Promise.all(tokens.map((t) => decodeId(SECRET, "variant", t)));
    expect(back).toEqual(ids);
  }, 30_000);

  it("does not leak adjacency: neighbouring ids are not neighbouring tokens", async () => {
    const a = await encodeId(SECRET, "variant", 1000);
    const b = await encodeId(SECRET, "variant", 1001);
    const na = parseInt(a.slice(2), 16);
    const nb = parseInt(b.slice(2), 16);
    expect(Math.abs(na - nb)).toBeGreaterThan(1000);
  });

  it("spreads tokens over the whole 32-bit space, so guessing is ~0,0024%", async () => {
    const tokens = await encodeIds(SECRET, "variant", Array.from({ length: 2000 }, (_, i) => i + 1));
    const highNibbleSeen = new Set(tokens.map((t) => t[2]));
    // 2000 sequential ids landing in only a couple of buckets would mean the
    // output is structured, i.e. still walkable.
    expect(highNibbleSeen.size).toBeGreaterThanOrEqual(14);
  });

  it("separates domains: the same id is a different token per kind", async () => {
    const v = await encodeId(SECRET, "variant", 500);
    const g = await encodeId(SECRET, "generation", 500);
    const m = await encodeId(SECRET, "model", 500);
    expect(new Set([v.slice(2), g.slice(2), m.slice(2)]).size).toBe(3);
  });

  it("refuses a token of the wrong kind outright, before the cipher runs", async () => {
    const v = await encodeId(SECRET, "variant", 500);
    expect(await decodeId(SECRET, "generation", v)).toBeNull();
    expect(await decodeId(SECRET, "model", v)).toBeNull();
  });

  it("never decodes a variant token to the same id under another kind's key", async () => {
    // Even with the prefix rewritten by hand, the per-kind key must not agree.
    const v = await encodeId(SECRET, "variant", 500);
    const forged = `g_${v.slice(2)}`;
    expect(await decodeId(SECRET, "generation", forged)).not.toBe(500);
  });

  it("is stable for a given secret and changes with the secret", async () => {
    const a = await encodeId(SECRET, "variant", 777);
    __resetIdKeyCache();
    const again = await encodeId(SECRET, "variant", 777);
    expect(again).toBe(a);
    __resetIdKeyCache();
    const other = await encodeId(OTHER, "variant", 777);
    expect(other).not.toBe(a);
  });

  it("returns null for malformed tokens instead of throwing", async () => {
    for (const bad of ["", "v_", "v_zzzzzzzz", "v_123", "1234", "v_123456789", "../../etc", "v_ 0000001"]) {
      expect(await decodeId(SECRET, "variant", bad)).toBeNull();
    }
  });

  it("accepts a token with surrounding whitespace, as a query param may carry", async () => {
    const t = await encodeId(SECRET, "variant", 9);
    expect(await decodeId(SECRET, "variant", `  ${t} `)).toBe(9);
  });

  it("FAILS CLOSED when the secret is missing or too short", async () => {
    await expect(encodeId(undefined, "variant", 1)).rejects.toThrow(MissingIdSecret);
    await expect(encodeId("", "variant", 1)).rejects.toThrow(MissingIdSecret);
    await expect(encodeId("short", "variant", 1)).rejects.toThrow(MissingIdSecret);
    await expect(decodeId(undefined, "variant", "v_00000001")).rejects.toThrow(MissingIdSecret);
  });

  it("rejects the id 0 and anything that decodes outside a plausible range", async () => {
    const zero = await encodeId(SECRET, "variant", 0);
    expect(await decodeId(SECRET, "variant", zero)).toBeNull();
  });
});

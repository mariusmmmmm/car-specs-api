import { describe, test, expect, vi } from "vitest";

// The response gate hands out tokens and the routes read them back. Those are
// two files, so they can disagree — and if they do, every client breaks on its
// SECOND call, which is the kind of thing a unit test on either side alone
// passes happily.
const seen: { variantId?: number; cursor?: number } = {};

vi.mock("../src/lib/db", () => ({
  getDb: () => {
    const sql = (async () => []) as never;
    return sql;
  },
}));
vi.mock("../src/lib/queries", () => ({
  variantExists: async (_s: unknown, id: number) => { seen.variantId = id; return false; },
  getVariantImages: async () => [],
  filterVariants: async (_s: unknown, _l: string, f: { cursor: number }) => { seen.cursor = f.cursor; return []; },
}));
vi.mock("../src/lib/localize-variant", () => ({
  localizeVariantSpecs: async (_s: unknown, _l: string, id: number) => { seen.variantId = id; return null; },
}));
vi.mock("../src/lib/meta", () => ({ maxSyncedAt: () => "2026-10-05T00:00:00.000Z" }));

const { variants } = await import("../src/routes/variants");
const { encodeId } = await import("../src/lib/public-id");

const SECRET = "test-secret-at-least-16-chars-long";
const env = { ID_TOKEN_KEY: SECRET, HYPERDRIVE: {} } as never;

describe("opaque ids survive a round trip (T107)", () => {
  test("a variant token sent back resolves to the original id", async () => {
    const token = await encodeId(SECRET, "variant", 103_099);
    await variants.fetch(new Request(`http://x/${token}/specs`), env);
    expect(seen.variantId).toBe(103_099);
  });

  test("a cursor token sent back resolves to the original offset", async () => {
    const cursor = await encodeId(SECRET, "cursor", 5150);
    await variants.fetch(new Request(`http://x/?cursor=${cursor}`), env);
    expect(seen.cursor).toBe(5150);
  });

  test("a RAW integer id is no longer accepted — the old contract is closed", async () => {
    // Someone replaying a pre-T107 URL must get a clean 404, not a silent hit.
    const res = await variants.fetch(new Request("http://x/103099/specs"), env);
    expect(res.status).toBe(404);
  });

  test("a malformed cursor restarts at the first page instead of 400-ing", async () => {
    seen.cursor = -1;
    await variants.fetch(new Request("http://x/?cursor=not-a-cursor"), env);
    expect(seen.cursor).toBe(0);
  });

  test("a token of the wrong KIND is refused — a generation token is not a variant", async () => {
    const gen = await encodeId(SECRET, "generation", 500);
    const res = await variants.fetch(new Request(`http://x/${gen}/specs`), env);
    expect(res.status).toBe(404);
  });
});

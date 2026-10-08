import { describe, test, expect, vi } from "vitest";
import { Hono } from "hono";

// T157 — the drill-down brand -> model -> generation, end to end.
//
// This file exists because every unit test on either half passed while the
// chain was broken for MONTHS. `/brands/:slug/models` projected the model's
// public_id as `id`; the gate in middleware/opaque-ids.ts rewrites
// `model_id`/`generation_id`/`variant_id` and knows nothing about `id`, so the
// list handed out a raw integer. Its successor route decodes STRICTLY an `m_…`
// token, so it answered 404 to the only id its own predecessor ever produced.
//
// So the assertion here is not "the field is named X". It is: take the id the
// FIRST route returns, feed it verbatim to the SECOND route, and demand that
// the second route resolve it to the row the first one meant. That is the only
// shape of test that could have caught this, and the only one that keeps it
// caught.

const MODEL_PUBLIC_ID = 2151; // the id measured in the T157 report: bmw/3-series
const GENERATION_PUBLIC_ID = 7608;

/** What the second route actually received, after the gate and after readId. */
const seen: { modelId?: number | null } = {};

vi.mock("../src/lib/db", () => ({
  // The models list runs its own tagged-template query. One row is enough: a
  // non-empty result skips the brand-exists probe, so nothing else is called.
  getDb: () => {
    const sql = (async () => [
      {
        // Both spellings on the ROW, deliberately: the DB column alias is an
        // implementation detail and this test must measure the RESPONSE
        // contract, not the SQL. On pre-T157 code the handler picks `id` and
        // the chain breaks; on fixed code it picks `model_id` and it holds.
        id: MODEL_PUBLIC_ID,
        model_id: MODEL_PUBLIC_ID,
        brand_id: 1013,
        slug: "3-series",
        name: "3 Series",
        last_synced_at: null,
      },
    ]) as never;
    return sql;
  },
}));

vi.mock("../src/lib/queries", () => ({
  listGenerationsForModel: async (_s: unknown, _l: string, modelId: number) => {
    seen.modelId = modelId;
    return [
      {
        id: GENERATION_PUBLIC_ID,
        generation_id: GENERATION_PUBLIC_ID,
        model_id: MODEL_PUBLIC_ID,
        slug: "f30",
        name: "F30",
        years_start: 2012,
        years_end: 2019,
        last_synced_at: null,
      },
    ];
  },
}));

vi.mock("../src/lib/meta", () => ({ maxSyncedAt: () => "2026-10-08T00:00:00.000Z" }));

const { catalog } = await import("../src/routes/catalog");
const { opaqueIds } = await import("../src/middleware/opaque-ids");
const { decodeId } = await import("../src/lib/public-id");

const SECRET = "test-secret-at-least-16-chars-long";
const env = { ID_TOKEN_KEY: SECRET, HYPERDRIVE: {} } as never;

/** The catalog routes as a client meets them: behind the SAME response gate
 *  routes/v1.ts mounts. Testing the router bare would have hidden the bug —
 *  the gate is the half that was supposed to tokenise the field. */
function client() {
  const app = new Hono();
  app.use("*", opaqueIds as never);
  app.route("/", catalog);
  return (path: string) => app.fetch(new Request(`http://x${path}`), env);
}

describe("T157 — brand -> model -> generation is reachable end to end", () => {
  test("the model id from /brands/:slug/models WORKS on /models/:id/generations", async () => {
    const get = client();

    // Step 1: what does the list actually hand a client?
    const listRes = await get("/brands/bmw/models");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { model_id: string }[] };
    const modelToken = list.data[0]!.model_id;

    // It must be a token, not the raw public_id — this is also the leak T111
    // closed everywhere else (public_id runs 4..115170, ~89% of the range is a
    // live row, so a raw id is an enumerable handle on the catalogue).
    expect(modelToken).toMatch(/^m_[0-9a-f]{8}$/);

    // Step 2: hand that id straight back, verbatim, exactly as a client would.
    seen.modelId = undefined;
    const genRes = await get(`/models/${modelToken}/generations`);

    // This is the assertion the old code failed: 404 "No model with id 2151".
    expect(genRes.status).toBe(200);
    // …and it resolved to the row the first route meant, not merely to *a* row.
    expect(seen.modelId).toBe(MODEL_PUBLIC_ID);

    // Step 3: the generation id it hands on must itself be usable — the chain
    // does not stop at generations, /generations/:id/variants reads a `g_…`.
    const gens = (await genRes.json()) as { data: { generation_id: string; model_id: string }[] };
    const genToken = gens.data[0]!.generation_id;
    expect(genToken).toMatch(/^g_[0-9a-f]{8}$/);
    expect(await decodeId(SECRET, "generation", genToken)).toBe(GENERATION_PUBLIC_ID);
    // and the back-reference stays a model token, so a client can climb back up
    expect(await decodeId(SECRET, "model", gens.data[0]!.model_id)).toBe(MODEL_PUBLIC_ID);
  });

  test("no bare `id` survives in EITHER response — the raw public_id is gone", async () => {
    const get = client();

    const listBody = (await (await get("/brands/bmw/models")).json()) as { data: Record<string, unknown>[] };
    expect(listBody.data[0]).not.toHaveProperty("id");
    expect(JSON.stringify(listBody)).not.toContain(String(MODEL_PUBLIC_ID));

    const token = await (async () => {
      const b = (await (await get("/brands/bmw/models")).json()) as { data: { model_id: string }[] };
      return b.data[0]!.model_id;
    })();

    const genBody = (await (await get(`/models/${token}/generations`)).json()) as {
      data: Record<string, unknown>[];
    };
    expect(genBody.data[0]).not.toHaveProperty("id");
    expect(JSON.stringify(genBody)).not.toContain(String(GENERATION_PUBLIC_ID));
  });

  test("a RAW integer model id is still refused — the leak does not come back as an input", async () => {
    // Belt and braces: if someone "fixes" a future 404 report by accepting
    // integers again, the field rename would be cosmetic and the id space open.
    const res = await client()(`/models/${MODEL_PUBLIC_ID}/generations`);
    expect(res.status).toBe(404);
  });
});

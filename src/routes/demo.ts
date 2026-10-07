import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { demoSetReady, DEMO_SET_DESCRIPTION } from "../lib/demo-set";
import { loadDemoPayload, type DemoPayload, type DemoVariant } from "../lib/demo-payload";
import { encodeId, decodeId } from "../lib/public-id";

// Everything a demo key can reach (T111). Mounted AHEAD of the database routes
// and short-circuits them, so a demo request never receives a Postgres
// connection. Its scope is not enforced here — it is structural: the blob holds
// 40 cars and there is no code path from here to anything else.
export const demo = new Hono<{ Bindings: Env; Variables: Variables }>();

const UPGRADE =
  "The demo covers 40 cars — the only self-serve tier. The full catalogue is a licensed export: https://cars-data.com/en/api";

/** 503, not 404 or an empty list. A demo that answers "no cars" to whoever is
 *  evaluating us reads as a broken catalogue, and that is the one impression
 *  this tier exists to prevent. Says plainly that it is our side. */
function unavailable(c: { json: (b: unknown, s: number, h: Record<string, string>) => Response }) {
  const { body, status, headers } = problem(
    503,
    "Service Unavailable",
    "The demo dataset is being rebuilt and is briefly unavailable. Nothing is wrong with your key — retry shortly.",
  );
  return c.json(body, status, { ...headers, "Retry-After": "300" });
}

function outsideSet(c: { json: (b: unknown, s: number, h: Record<string, string>) => Response }) {
  const { body, status, headers } = problem(403, "Forbidden", `This car is outside the demo set. ${UPGRADE}`);
  return c.json(body, status, headers);
}

async function payloadFor(c: { env: Env; req: { query: (k: string) => string | undefined } }) {
  const locale = resolveLocale(c.req.query("locale"));
  if (!demoSetReady()) return { locale, payload: null as DemoPayload | null };
  return { locale, payload: await loadDemoPayload(c.env, locale) };
}

/** The shape every demo row has on the wire: opaque ids, no internal numbers. */
async function row(env: Env, v: DemoVariant) {
  return {
    variant_id: await encodeId(env.ID_TOKEN_KEY, "variant", v.variant_id),
    generation_id: await encodeId(env.ID_TOKEN_KEY, "generation", v.generation_id),
    model_id: await encodeId(env.ID_TOKEN_KEY, "model", v.model_id),
    brand: v.brand,
    model: v.model,
    generation: v.generation,
    display_name: v.display_name,
    fuel: v.fuel,
    body_type: v.body_type,
    years: v.years,
    power_hp: v.power_hp,
    battery_kwh: v.battery_kwh,
    price_new_eur: v.price_new_eur,
  };
}

// ── the index: one call that hands over the whole demo ──────────────────────
// A demo should not require guessing which cars are in it. This is also what
// makes refusing /search harmless for an agent: the whole set fits in one
// response, so there is nothing to search FOR that is not already here.
demo.get("/demo", async (c) => {
  const { locale, payload } = await payloadFor(c);
  if (!payload) return unavailable(c);
  return c.json(
    envelope(
      {
        set: DEMO_SET_DESCRIPTION,
        variant_count: payload.variants.length,
        fuels: [...new Set(payload.variants.map((v) => v.fuel))].sort(),
        variants: await Promise.all(payload.variants.map((v) => row(c.env, v))),
        upgrade: UPGRADE,
      },
      { locale, last_synced_at: payload.built_at },
    ),
  );
});

// ── the same routes the full API exposes, answered from the blob ────────────
async function findVariant(c: { env: Env; req: { param: (k: string) => string | undefined; query: (k: string) => string | undefined } }) {
  const { locale, payload } = await payloadFor(c);
  if (!payload) return { locale, payload: null, variant: null };
  const id = await decodeId(c.env.ID_TOKEN_KEY, "variant", c.req.param("id") ?? "");
  const variant = id === null ? null : payload.variants.find((v) => v.variant_id === id) ?? null;
  return { locale, payload, variant };
}

demo.get("/variants/:id", async (c) => {
  const { locale, payload, variant } = await findVariant(c);
  if (!payload) return unavailable(c);
  if (!variant) return outsideSet(c);
  return c.json(envelope(await row(c.env, variant), { locale, last_synced_at: payload.built_at }));
});

demo.get("/variants/:id/specs", async (c) => {
  const { locale, payload, variant } = await findVariant(c);
  if (!payload) return unavailable(c);
  if (!variant) return outsideSet(c);
  return c.json(
    envelope(
      { ...(await row(c.env, variant)), specs: variant.specs },
      { locale, last_synced_at: payload.built_at },
    ),
  );
});

// Images ARE in the demo (T111 §5.1). The earlier plan excluded them because
// the image module is the dearest one (€1.490) and the only one served from R2
// — true under a QUOTA model, where a key can walk the whole catalogue's
// images. Under a fixed set it is 40 cars' worth, cached at the edge forever,
// and photos are what make a demo convincing.
demo.get("/variants/:id/images", async (c) => {
  const { locale, payload, variant } = await findVariant(c);
  if (!payload) return unavailable(c);
  if (!variant) return outsideSet(c);
  return c.json(envelope(variant.images, { locale, last_synced_at: payload.built_at }));
});

demo.get("/compare", async (c) => {
  const { locale, payload } = await payloadFor(c);
  if (!payload) return unavailable(c);
  const raw = c.req.query("ids");
  if (!raw) {
    const { body, status, headers } = problem(400, "Bad Request", "Missing required query param: ids");
    return c.json(body, status, headers);
  }
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) {
    const { body, status, headers } = problem(400, "Bad Request", "ids must contain 2-4 variant IDs.");
    return c.json(body, status, headers);
  }
  const ids = await Promise.all(tokens.map((t) => decodeId(c.env.ID_TOKEN_KEY, "variant", t)));
  const found = ids.map((id) => (id === null ? null : payload.variants.find((v) => v.variant_id === id) ?? null));
  if (found.some((v) => v === null)) return outsideSet(c);
  return c.json(
    envelope(
      await Promise.all(
        (found as DemoVariant[]).map(async (v) => ({ ...(await row(c.env, v)), specs: v.specs })),
      ),
      { locale, last_synced_at: payload.built_at },
    ),
  );
});

// Search over 40 rows, in the Worker. Substring match on the display name,
// brand and model — enough for an agent's first call to return something real,
// and there is no catalogue behind it to walk.
demo.get("/search", async (c) => {
  const { locale, payload } = await payloadFor(c);
  if (!payload) return unavailable(c);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const hits = q
    ? payload.variants.filter((v) =>
        `${v.brand} ${v.model} ${v.generation} ${v.display_name}`.toLowerCase().includes(q),
      )
    : payload.variants;
  return c.json(
    envelope(await Promise.all(hits.map((v) => row(c.env, v))), {
      locale,
      last_synced_at: payload.built_at,
      demo_note: hits.length === 0 ? `No match inside the demo set. ${UPGRADE}` : undefined,
    }),
  );
});

// The taxonomy is open on the full API because it is already public on the
// site and in the sitemaps. On demo it is answered from the blob anyway, so
// the tier stays off the database entirely.
demo.get("/brands", async (c) => {
  const { locale, payload } = await payloadFor(c);
  if (!payload) return unavailable(c);
  const brands = [...new Set(payload.variants.map((v) => v.brand))].sort();
  return c.json(
    envelope(
      brands.map((b) => ({
        brand: b,
        models: [...new Set(payload.variants.filter((v) => v.brand === b).map((v) => v.model))].sort(),
      })),
      { locale, last_synced_at: payload.built_at },
    ),
  );
});

/** Anything else a demo key asks for. 403 with the upgrade path rather than a
 *  404: the route exists, it is the tier that does not reach it, and telling an
 *  integrator "not found" would send them debugging their own client. */
demo.all("*", async (c) => {
  const { body, status, headers } = problem(
    403,
    "Forbidden",
    `${c.req.path} is not part of the demo tier. ${UPGRADE}`,
  );
  return c.json(body, status, headers);
});

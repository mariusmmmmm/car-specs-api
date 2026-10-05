import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { localizeVariantSpecs } from "../lib/localize-variant";
import { readIdList } from "../middleware/opaque-ids";

export const compare = new Hono<{ Bindings: Env }>();

compare.get("/", async (c) => {
  const idsParam = c.req.query("ids");
  if (!idsParam) {
    const { body, status, headers } = problem(400, "Bad Request", "Missing required query param: ids");
    return c.json(body, status, headers);
  }
  const tokens = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) {
    const { body, status, headers } = problem(400, "Bad Request", "ids must contain 2-4 variant IDs.");
    return c.json(body, status, headers);
  }
  // Decoded strictly. Until 2026-10-04 this filtered out anything unparseable,
  // so `?ids=<a>,typo,<b>` quietly compared two cars instead of three and
  // answered 200 — a wrong answer presented as a right one.
  const decoded = await readIdList(c, "variant", "ids");
  const badAt = decoded.findIndex((id) => id === null);
  if (badAt !== -1) {
    const { body, status, headers } = problem(400, "Bad Request", `Not a valid variant id: ${tokens[badAt]}`);
    return c.json(body, status, headers);
  }
  const ids = decoded as number[];

  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));

  const results = await Promise.all(ids.map((id) => localizeVariantSpecs(sql, locale, id)));
  const missing = ids.filter((_, i) => !results[i]);
  if (missing.length > 0) {
    const { body, status, headers } = problem(404, "Not Found", `No variant(s) with id ${missing.map((_, i) => tokens[i]).join(", ")}`);
    return c.json(body, status, headers);
  }

  let latest = new Date(0);
  const data = ids.map((id, i) => {
    const r = results[i]!;
    if (r.last_synced_at > latest) latest = r.last_synced_at;
    return { variant_id: id, locale, specs: r.specs };
  });

  return c.json(envelope(data, { locale, last_synced_at: latest.toISOString() }));
});

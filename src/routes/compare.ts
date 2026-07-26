import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { localizeVariantSpecs } from "../lib/localize-variant";

export const compare = new Hono<{ Bindings: Env }>();

compare.get("/", async (c) => {
  const idsParam = c.req.query("ids");
  if (!idsParam) {
    const { body, status, headers } = problem(400, "Bad Request", "Missing required query param: ids");
    return c.json(body, status, headers);
  }
  const ids = idsParam
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (ids.length < 2 || ids.length > 4) {
    const { body, status, headers } = problem(400, "Bad Request", "ids must contain 2-4 variant IDs.");
    return c.json(body, status, headers);
  }

  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));

  const results = await Promise.all(ids.map((id) => localizeVariantSpecs(sql, locale, id)));
  const missing = ids.filter((_, i) => !results[i]);
  if (missing.length > 0) {
    const { body, status, headers } = problem(404, "Not Found", `No variant(s) with id ${missing.join(", ")}`);
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

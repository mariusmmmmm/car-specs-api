import type { ContentfulStatusCode } from "hono/utils/http-status";

// Envelope + errors per BIZ-L2a-openapi-readmodel.md §2:
// { data, meta:{locale,units,last_synced_at}, links:{next} }; errors = RFC 9457 (problem+json).

export type Meta = {
  locale?: string;
  units?: "metric" | "imperial";
  last_synced_at: string;
  [key: string]: unknown;
};

export function envelope<T>(data: T, meta: Meta, links?: { next?: string }) {
  return { data, meta, ...(links ? { links } : {}) };
}

export function problem(
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
) {
  return {
    body: { type: "about:blank", title, status, ...(detail ? { detail } : {}), ...extra },
    status,
    headers: { "Content-Type": "application/problem+json" } as const,
  };
}

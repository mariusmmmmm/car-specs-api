import { describe, test, expect, vi } from "vitest";

// T1200 (D-75 §2) — `meta.build_sha` pe RUTĂ, nu doar în helper.
//
// `src/lib/build-info.test.ts` probează REGULA („omis, nu gol"). Asta probează
// CABLAJUL: că `/v1/health` chiar împrăștie helperul în `meta`. Fără ea, regula
// putea fi corectă și câmpul să nu ajungă niciodată în răspuns — exact clasa
// „zero pe suprafața greșită se citește ca nelivrat".
//
// `SELECT 1 FROM variants LIMIT 1` e verificarea de viață a rutei; un tag care
// întoarce un rând e tot ce-i trebuie.
vi.mock("../src/lib/db", () => ({
  getDb: () => (async () => [{ "?column?": 1 }]) as unknown,
}));

const { v1 } = await import("../src/routes/v1");

function env(over: Record<string, unknown> = {}) {
  return { HYPERDRIVE: { connectionString: "postgres://unused" }, ...over } as never;
}

async function health(e: unknown) {
  const res = await v1.request("/health", {}, e);
  return { status: res.status, body: (await res.json()) as { meta: Record<string, unknown> } };
}

describe("/v1/health — meta.build_sha (T1200)", () => {
  test("fără BUILD_SHA: cheia LIPSEȘTE din meta, nu e null sau gol", async () => {
    const { status, body } = await health(env());
    expect(status).toBe(200);
    expect("build_sha" in body.meta).toBe(false);
    // Și în JSON-ul servit, nu doar în obiect.
    expect(JSON.stringify(body.meta)).not.toContain("build_sha");
    // Proba inversă: meta chiar s-a construit, deci absența nu e „n-am citit".
    expect(body.meta.catalogue_as_of).toBeTruthy();
  });

  test("cu BUILD_SHA: ajunge în meta, exact ca valoare", async () => {
    const { body } = await health(env({ BUILD_SHA: "39ee866abc12" }));
    expect(body.meta.build_sha).toBe("39ee866abc12");
  });

  test("BUILD_SHA gol (`--var BUILD_SHA:`): tot omis", async () => {
    const { body } = await health(env({ BUILD_SHA: "   " }));
    expect("build_sha" in body.meta).toBe(false);
  });
});

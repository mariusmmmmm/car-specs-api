import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseX402Config, type X402Env } from "../src/lib/x402-config";

// T230 — the activation lives in wrangler.toml. A malformed value there does not
// crash anything: lib/x402-config.ts treats it as OFF, logs once, and the
// Worker quietly answers 401. So the only place a typo in the address is caught
// before production is here.

function tomlVars(): X402Env {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const section = toml.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const vars: Record<string, string> = {};
  for (const m of section.matchAll(/^(X402_[A-Z_]+)\s*=\s*"([^"]*)"\s*$/gm)) vars[m[1]!] = m[2]!;
  return vars;
}

describe("wrangler.toml activates x402 with a configuration the Worker accepts (T230)", () => {
  test("the [vars] in wrangler.toml parse as ON", () => {
    const r = parseX402Config(tomlVars());
    expect(r).toMatchObject({ ok: true });
  });

  test("it is the owner's address, on Base MAINNET, through PayAI (T231)", () => {
    const r = parseX402Config(tomlVars());
    if (!r.ok) throw new Error("x402 config is off");
    expect(r.settings.payTo.toLowerCase()).toBe("0x3866d32426a12db52e155563768bea9516bbab49");
    expect(r.settings.network).toBe("eip155:8453");
    expect(r.settings.facilitatorUrl).toBe("https://facilitator.payai.network");
  });
});

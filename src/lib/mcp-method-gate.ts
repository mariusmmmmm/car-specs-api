// What /mcp answers to a probe that is not a JSON-RPC call.
//
// Lives in its own module because src/index.ts cannot be imported by a test:
// it pulls in agents/mcp, which imports from `cloudflare:workers`, and Node's
// ESM loader refuses that scheme outside workerd. A rule that cannot be tested
// is a rule that drifts, so the rule moved here instead of the test being
// dropped.
//
// HEAD returned 404 until 2026-10-06, and 404 on a HEAD is a discoverability
// liability: registries, uptime monitors and link checkers probe with HEAD, and
// "not found" reads as "no such endpoint" — while POST was answering handshakes
// perfectly. This project's own MCP-REGISTRY-PUBLISH.md ran exactly that probe
// and would have concluded the server was broken.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** A response when the method cannot carry an MCP call, or null to continue. */
export function mcpMethodGate(method: string): Response | null {
  if (method !== "HEAD") return null;
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST, OPTIONS", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
  });
}

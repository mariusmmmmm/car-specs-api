import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.MCP_BASE ?? "http://localhost:8790";

async function main() {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(
    "Tools:",
    tools.tools.map((t) => t.name),
  );

  const search = await client.callTool({ name: "search_cars", arguments: { query: "corolla", locale: "ro" } });
  console.log("\nsearch_cars(corolla):", search.content[0].text.slice(0, 300));

  const searchData = JSON.parse(search.content[0].text);
  const variantId = searchData[0].variant_id;

  const specs = await client.callTool({ name: "get_specs", arguments: { variant_id: variantId, locale: "ro" } });
  const specsData = JSON.parse(specs.content[0].text);
  console.log(`\nget_specs(${variantId}, ro): ${Object.keys(specsData.specs).length} specs`);
  console.log("sample:", Object.entries(specsData.specs)[0]);

  const filter = await client.callTool({
    name: "filter_cars",
    arguments: { fuel: "electric", power_min: 200, limit: 3 },
  });
  console.log("\nfilter_cars(electric, power_min=200):", JSON.parse(filter.content[0].text).length, "hits");

  const images = await client.callTool({ name: "get_images", arguments: { variant_id: variantId } });
  console.log("\nget_images:", JSON.parse(images.content[0].text).length, "images");

  const gens = await client.callTool({ name: "list_generations", arguments: { model_id: 3208 } });
  console.log("\nlist_generations(model 3208):", JSON.parse(gens.content[0].text).length, "generations");

  const cmp = await client.callTool({
    name: "compare_variants",
    arguments: { variant_ids: [variantId, searchData[1].variant_id], locale: "de" },
  });
  console.log("\ncompare_variants:", JSON.parse(cmp.content[0].text).data.length, "variants compared");

  await client.close();
  console.log("\nMCP smoke test PASS");
}

main().catch((err) => {
  console.error("MCP test failed:", err);
  process.exit(1);
});

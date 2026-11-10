// Fetches the prod Tenor API spec and keeps what the clients expose.
import { writeFileSync } from "node:fs";

const SOURCE = "https://tenor-api.tenor.finance/v1/openapi.json";
const OUT = new URL("../openapi/trading-api.json", import.meta.url);
// Docs and liveness routes, of no use to an SDK caller.
const SKIPPED = new Set(["getOpenApi", "getLlmsTxt", "getLive"]);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`GET ${SOURCE}: ${res.status}`);
const spec = await res.json();

spec.servers = spec.servers.filter((s) => s.url === "https://tenor-api.tenor.finance");
if (spec.servers.length !== 1) throw new Error("prod server missing from the spec");

for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (SKIPPED.has(op.operationId)) delete item[method];
  }
  if (Object.keys(item).length === 0) delete spec.paths[path];
}
// Only the OpenAPI document route used it.
delete spec.components.schemas.OpenApiDocument;

writeFileSync(OUT, JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote ${Object.keys(spec.paths).length} paths from ${SOURCE}`);

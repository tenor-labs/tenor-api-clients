// Generates the client from ../../openapi/trading-api.json:
// - src/gen/types.gen.ts: hey-api types, from a camelCased copy of the spec
// - src/gen/operations.gen.ts: per operation, the route and the shapes the runtime
//   uses to rename keys between camelCase and the wire's snake_case
// - src/gen/client.gen.ts: the Tenor class, one method per operation
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient } from "@hey-api/openapi-ts";
import { camel, camelizeSpec } from "./camelize.ts";

type Json = any;

const root = new URL("../", import.meta.url).pathname;
const spec: Json = JSON.parse(readFileSync(`${root}../../openapi/trading-api.json`, "utf8"));
const outDir = `${root}src/gen`;
const buildDir = `${root}.build`;

const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);

// ---------- shapes: which keys to rename, read from the wire spec ----------

// 0: leave the value as is. A string: a component. {o, m}: an object with known
// properties [wire key → [camel key, shape]] and, for maps, the shape of every
// value (keys kept). {a}: an array.
type Shape = 0 | string | { o?: Record<string, [string, Shape]>; m?: Shape } | { a: Shape };

const components: Record<string, Json> = spec.components.schemas;

function resolve(shape: Shape): Exclude<Shape, string> {
  return typeof shape === "string" ? compiled[shape]! : shape;
}

function merge(shapes: Shape[], where: string): Shape {
  const live = shapes.filter((s) => s !== 0);
  if (live.length <= 1) return live[0] ?? 0;
  const resolved = live.map(resolve);
  if (resolved.every((s) => s !== 0 && "a" in s)) {
    return { a: merge(resolved.map((s) => (s as { a: Shape }).a), where) };
  }
  const o: Record<string, [string, Shape]> = {};
  let m: Shape | undefined;
  for (const s of resolved) {
    if (s === 0 || "a" in s) throw new Error(`${where}: cannot merge an array with an object`);
    for (const [k, v] of Object.entries(s.o ?? {})) {
      if (o[k] && JSON.stringify(o[k]) !== JSON.stringify(v)) throw new Error(`${where}.${k}: conflicting union members`);
      o[k] = v;
    }
    if (s.m !== undefined) m = s.m;
  }
  return m === undefined ? { o } : { o, m };
}

function compile(schema: Json, where: string): Shape {
  if (!schema || typeof schema !== "object") return 0;
  if (schema.$ref) return schema.$ref.replace("#/components/schemas/", "");
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return merge(union.map((s: Json, i: number) => compile(s, `${where}|${i}`)), where);
  if (schema.allOf) return merge(schema.allOf.map((s: Json, i: number) => compile(s, `${where}&${i}`)), where);
  const types = [schema.type].flat();
  if (types.includes("array")) {
    const items = compile(schema.items, `${where}[]`);
    return items === 0 ? 0 : { a: items };
  }
  if (!schema.properties) {
    // A map: keys are data (addresses, chain names, ABI argument names), never renamed.
    const ap = schema.additionalProperties;
    const values = ap && typeof ap === "object" ? compile(ap, `${where}{}`) : 0;
    return values === 0 ? 0 : { o: {}, m: values };
  }
  const o: Record<string, [string, Shape]> = {};
  for (const [k, v] of Object.entries(schema.properties)) o[k] = [camel(k), compile(v, `${where}.${k}`)];
  const ap = schema.additionalProperties;
  if (ap === true || (ap && typeof ap === "object")) return { o, m: compile(ap, `${where}{}`) };
  return { o };
}

const compiled: Record<string, Exclude<Shape, string>> = {};
// Unions merge their members' compiled shapes, so compile until nothing changes.
for (const name of Object.keys(components)) compiled[name] = { o: {} };
for (let pass = 0, changed = true; changed; pass++) {
  if (pass > 20) throw new Error("schema shapes do not settle");
  const before = JSON.stringify(compiled);
  for (const [name, schema] of Object.entries(components)) {
    const shape = compile(schema, name);
    compiled[name] = typeof shape === "string" ? resolve(shape) : shape;
  }
  changed = JSON.stringify(compiled) !== before;
}

// ---------- operations ----------

interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  query: Record<string, string>;
  pathParams: Record<string, string>;
  hasBody: boolean;
  required: boolean;
  body: Shape;
  response: Shape;
}

const operations: Operation[] = [];
for (const [path, item] of Object.entries<Json>(spec.paths)) {
  for (const [method, op] of Object.entries<Json>(item)) {
    const params: Json[] = op.parameters ?? [];
    const named = (where: string) =>
      Object.fromEntries(params.filter((p) => p.in === where).map((p) => [camel(p.name), p.name]));
    const success = op.responses["200"].content["application/json"].schema;
    const body = op.requestBody?.content["application/json"].schema;
    const pathParams = named("path");
    const query = named("query");
    const collide = Object.keys(pathParams).find((k) => k in query);
    if (collide) throw new Error(`${op.operationId}: ${collide} is both a path and a query parameter`);
    if (body && params.length) throw new Error(`${op.operationId}: a body and parameters cannot share one argument`);
    operations.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      summary: op.summary ?? "",
      description: op.description ?? "",
      query,
      pathParams,
      hasBody: !!body,
      required: body ? op.requestBody.required === true : params.some((p) => p.required),
      body: body ? compile(body, `${op.operationId}.body`) : 0,
      response: compile(success, `${op.operationId}.200`),
    });
  }
}
operations.sort((a, b) => a.id.localeCompare(b.id));

// ---------- write ----------

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
writeFileSync(`${buildDir}/openapi.camel.json`, JSON.stringify(camelizeSpec(spec), null, 2));

await createClient({
  input: `${buildDir}/openapi.camel.json`,
  output: { path: outDir, clean: true },
  plugins: ["@hey-api/typescript"],
  logs: { level: "silent" },
});
// Its barrel imports without extensions; src/index.ts re-exports the types instead.
rmSync(`${outDir}/index.ts`);

const header = "// Generated by scripts/generate.ts from openapi/trading-api.json. Do not edit.\n";

writeFileSync(
  `${outDir}/operations.gen.ts`,
  `${header}import type { Operation, Shape } from "../runtime.js";

export const SHAPES: Record<string, Shape> = ${JSON.stringify(compiled)};

export const OPERATIONS = ${JSON.stringify(
    Object.fromEntries(
      operations.map((o) => [
        o.id,
        { method: o.method, path: o.path, query: o.query, pathParams: o.pathParams, body: o.body, response: o.response },
      ]),
    ),
  )} satisfies Record<string, Operation>;
`,
);

const doc = (o: Operation) => {
  const lines = [o.summary, "", ...o.description.split("\n")].map((l) => l.replaceAll("*/", "*\\/"));
  while (lines.at(-1) === "") lines.pop();
  return ["  /**", ...lines.map((l) => (l ? `   * ${l}` : "   *")), `   *`, `   * \`${o.method} ${o.path}\``, "   */"].join("\n");
};

const typeImports = new Set<string>();
const methods = operations.map((o) => {
  const name = pascal(o.id);
  const takesParams = o.hasBody || Object.keys(o.pathParams).length + Object.keys(o.query).length > 0;
  if (takesParams) typeImports.add(`${name}Data`);
  typeImports.add(`${name}Response`);
  const params = o.hasBody
    ? `${name}Data["body"]`
    : [Object.keys(o.pathParams).length && `${name}Data["path"]`, Object.keys(o.query).length && `NonNullable<${name}Data["query"]>`]
        .filter(Boolean)
        .join(" & ") || "Record<string, never>";
  const arg = o.required ? `params: ${params}` : `params: ${params} = {}`;
  return `${doc(o)}
  ${o.id}(${arg}, options?: RequestOptions): Promise<${name}Response> {
    return this.request(OPERATIONS.${o.id}, params, options);
  }`;
});

writeFileSync(
  `${outDir}/client.gen.ts`,
  `${header}import { BaseClient, type RequestOptions } from "../runtime.js";
import { OPERATIONS } from "./operations.gen.js";
import type {
${[...typeImports].sort().map((t) => `  ${t},`).join("\n")}
} from "./types.gen.js";

export class Tenor extends BaseClient {
${methods.join("\n\n")}
}
`,
);

console.log(`generated ${operations.length} operations, ${Object.keys(compiled).length} schemas`);

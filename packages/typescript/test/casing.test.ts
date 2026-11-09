import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { camelizeSpec } from "../scripts/camelize.ts";
import { OPERATIONS } from "../src/gen/operations.gen.ts";
import { fromWire, toWire } from "../src/runtime.ts";

const wireSpec = JSON.parse(readFileSync(new URL("../../../openapi/trading-api.json", import.meta.url), "utf8"));
const camelSpec = camelizeSpec(wireSpec);

// A value for every field of a schema. `pick` chooses the member of each union, so
// two picks cover both sides of the size unions. Map keys are snake_case and
// must come through untouched.
function sample(spec: any, schema: any, pick: number, depth = 0): unknown {
  if (schema.$ref) return sample(spec, spec.components.schemas[schema.$ref.split("/").at(-1)], pick, depth + 1);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const members = union.filter((m: any) => m.type !== "null");
    return members.length ? sample(spec, members[pick % members.length], pick, depth + 1) : null;
  }
  const type = [schema.type].flat().find((t) => t !== "null");
  // Onchain calls nest; stop after a few levels.
  if (type === "array") return depth > 12 ? [] : [sample(spec, schema.items ?? {}, pick, depth + 1)];
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) out[k] = sample(spec, v, pick, depth + 1);
    return out;
  }
  if (type === "object" || schema.additionalProperties) {
    const ap = schema.additionalProperties;
    const typed = ap && typeof ap === "object" && Object.keys(ap).length > 0;
    return { some_map_key: typed ? sample(spec, ap, pick, depth + 1) : { inner_key: 1 } };
  }
  if ("const" in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  return { string: "s", integer: 1, number: 1.5, boolean: true }[type as string] ?? null;
}

const operations = Object.entries(wireSpec.paths).flatMap(([path, item]: [string, any]) =>
  Object.entries(item).map(([method, op]: [string, any]) => {
    const camelPath = path.replace(/\{([^}]+)\}/g, (_, n: string) => `{${n.replace(/_(.)/g, (__, c: string) => c.toUpperCase())}}`);
    return { path, method, op, camelOp: camelSpec.paths[camelPath][method] };
  }),
);

describe.each(operations)("$op.operationId", ({ op, camelOp }) => {
  const runtime = OPERATIONS[op.operationId as keyof typeof OPERATIONS];

  it.each([0, 1])("renames the response, union member %i", (pick) => {
    const schema = (o: any) => o.responses["200"].content["application/json"].schema;
    const wire = sample(wireSpec, schema(op), pick);
    const camel = fromWire(runtime.response, wire);
    expect(camel).toEqual(sample(camelSpec, schema(camelOp), pick));
    expect(toWire(runtime.response, camel)).toEqual(wire);
  });

  it.each([0, 1])("renames the body, union member %i", (pick) => {
    if (!op.requestBody) return;
    const schema = (o: any) => o.requestBody.content["application/json"].schema;
    const wire = sample(wireSpec, schema(op), pick);
    const camel = sample(camelSpec, schema(camelOp), pick);
    expect(toWire(runtime.body, camel)).toEqual(wire);
    expect(fromWire(runtime.body, wire)).toEqual(camel);
  });

  it("maps every parameter", () => {
    const params = (o: any, where: string) =>
      (o.parameters ?? []).filter((p: any) => p.in === where).map((p: any) => p.name);
    for (const where of ["query", "path"] as const) {
      const table = where === "query" ? runtime.query : runtime.pathParams;
      expect(Object.keys(table)).toEqual(params(camelOp, where));
      expect(Object.values(table)).toEqual(params(op, where));
    }
  });
});

describe("fields this client doesn't know", () => {
  it("are renamed but their values are left alone", () => {
    const wire = { data: { new_field: { inner_key: 1 } }, meta: { request_id: "r" } };
    expect(fromWire(OPERATIONS.getAccess.response, wire)).toEqual({
      data: { newField: { inner_key: 1 } },
      meta: { requestId: "r" },
    });
  });
});

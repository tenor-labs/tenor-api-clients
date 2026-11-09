// The spec with every field and parameter renamed to camelCase, for hey-api.
type Json = any;

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function renameKeys(obj: Record<string, Json>, where: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(obj)) {
    const name = camel(k);
    if (name in out) throw new Error(`${where}: ${k} collides with another field as ${name}`);
    out[name] = v;
  }
  return out;
}

// Renames schema properties and parameters. Examples are wire-format data, so they
// are dropped rather than left in snake_case next to camelCase types.
function camelizeSchemas(node: Json, where: string): Json {
  if (Array.isArray(node)) return node.map((n, i) => camelizeSchemas(n, `${where}[${i}]`));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "example" || k === "examples") continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const renamed = renameKeys(v, where);
      out[k] = Object.fromEntries(
        Object.entries(renamed).map(([p, s]) => [p, camelizeSchemas(s, `${where}.${p}`)]),
      );
    } else if (k === "required" && Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v.map(camel);
    } else {
      out[k] = camelizeSchemas(v, `${where}/${k}`);
    }
  }
  if ((out.in === "query" || out.in === "path") && typeof out.name === "string") {
    out.name = camel(out.name);
  }
  return out;
}

export function camelizeSpec(s: Json): Json {
  const out = camelizeSchemas(s, "#");
  out.paths = Object.fromEntries(
    Object.entries(out.paths).map(([p, item]) => [p.replace(/\{([^}]+)\}/g, (_, n: string) => `{${camel(n)}}`), item]),
  );
  return out;
}

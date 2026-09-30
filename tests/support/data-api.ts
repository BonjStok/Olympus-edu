// Reads DATA-API.yaml (the evaluator's scenario) without a YAML dependency. The file uses a small,
// fixed subset of YAML: block mappings and sequences indented with spaces, `- key: value` items,
// quoted and plain scalars, and one-line flow collections such as `[200]` or `{type: "string"}`.
// Anything outside that subset is reported with its line number instead of being guessed.
import fs from "node:fs";

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  no: number;
}

function fail(no: number, message: string): never {
  throw new Error(`YAML line ${no}: ${message}`);
}

/** One-line flow collection (`[a, "b", 1]`, `{type: "string", n: 1}`) or a nested mix of both. */
function parseFlow(text: string, no: number): Yaml {
  let i = 0;
  const space = () => {
    while (text[i] === " ") i++;
  };
  const value = (): Yaml => {
    space();
    if (text[i] === "[") {
      i++;
      const items: Yaml[] = [];
      space();
      while (text[i] !== "]") {
        items.push(value());
        space();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail(no, `expected , or ] in ${text}`);
      }
      i++;
      return items;
    }
    if (text[i] === "{") {
      i++;
      const map: Record<string, Yaml> = {};
      space();
      while (text[i] !== "}") {
        const key = value();
        space();
        if (text[i] !== ":") fail(no, `expected : in ${text}`);
        i++;
        map[String(key)] = value();
        space();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail(no, `expected , or } in ${text}`);
      }
      i++;
      return map;
    }
    if (text[i] === '"') {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i));
      if (!match) fail(no, `unterminated string in ${text}`);
      i += match[0].length;
      return JSON.parse(match[0]) as string;
    }
    const match = /^[^,:\]}]*/.exec(text.slice(i))!;
    i += match[0].length;
    return plain(match[0].trim());
  };
  const result = value();
  space();
  if (i !== text.length) fail(no, `unexpected text after a flow collection: ${text}`);
  return result;
}

function plain(text: string): Yaml {
  if (text === "null" || text === "~" || text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function scalar(raw: string, no: number): Yaml {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) fail(no, `bad double-quoted string ${text}`);
    return JSON.parse(text) as string;
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail(no, `bad single-quoted string ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[") || text.startsWith("{")) return parseFlow(text, no);
  if (/^[|>]/.test(text)) fail(no, "block scalars are not supported");
  if (/^[&*!]/.test(text)) fail(no, "anchors, aliases and tags are not supported");
  return plain(text.replace(/\s+#.*$/, ""));
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-[{][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

/** Parses the YAML subset described at the top of this file. */
export function parseYamlSubset(source: string): Yaml {
  const lines: Line[] = [];
  source.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes("\t")) fail(index + 1, "tabs are not allowed for indentation");
    lines.push({ indent: lead.length, text, no: index + 1 });
  });
  let pos = 0;

  const isItem = (line: Line) => line.text === "-" || line.text.startsWith("- ");

  const block = (): Yaml =>
    isItem(lines[pos]) ? sequence(lines[pos].indent) : mapping(lines[pos].indent);

  function mapping(indent: number): Record<string, Yaml> {
    const map: Record<string, Yaml> = {};
    while (pos < lines.length && lines[pos].indent === indent && !isItem(lines[pos])) {
      const line = lines[pos];
      const match = KEY.exec(line.text);
      if (!match) fail(line.no, `expected "key: value", got ${line.text}`);
      const key = String(scalar(match[1], line.no));
      if (key in map) fail(line.no, `duplicate key ${key}`);
      pos++;
      const next = lines[pos];
      if (match[2] !== undefined && match[2].trim() !== "") map[key] = scalar(match[2], line.no);
      else if (next && next.indent > indent) map[key] = block();
      else if (next && next.indent === indent && isItem(next)) map[key] = sequence(indent);
      else map[key] = null;
    }
    if (pos < lines.length && lines[pos].indent > indent)
      fail(lines[pos].no, "unexpected indentation");
    return map;
  }

  function sequence(indent: number): Yaml[] {
    const items: Yaml[] = [];
    while (pos < lines.length && lines[pos].indent === indent && isItem(lines[pos])) {
      const line = lines[pos];
      const rest = line.text.slice(1).trimStart();
      if (!rest) {
        pos++;
        items.push(lines[pos] && lines[pos].indent > indent ? block() : null);
      } else if (KEY.test(rest)) {
        // `- key: value` starts a mapping whose keys are aligned with `key`.
        const column = indent + (line.text.length - rest.length);
        lines[pos] = { indent: column, text: rest, no: line.no };
        items.push(mapping(column));
      } else {
        pos++;
        items.push(scalar(rest, line.no));
      }
    }
    return items;
  }

  if (!lines.length) return null;
  const result = block();
  if (pos < lines.length) fail(lines[pos].no, "unexpected content");
  return result;
}

// ---------------------------------------------------------------------------
// DATA-API.yaml
// ---------------------------------------------------------------------------

export interface DataApiCheck {
  id: string;
  name?: string;
  method: string;
  path: string;
  role: string;
  dependsOn?: string[];
  request?: {
    headers?: Record<string, string>;
    path?: Record<string, string>;
    body?: Record<string, Yaml>;
  };
  expected: {
    statusCodes: number[];
    contentType?: string;
    requiredFields?: string[];
    bodySchema?: Yaml;
  };
  timeoutMs?: number;
  repeatable?: boolean;
  extract?: Record<string, string>;
}

export interface DataApi {
  schemaVersion: string;
  solution: { name: string; teamId: string };
  api: { baseUrl: string; openapi: string; defaultHeaders?: Record<string, string> };
  checks: DataApiCheck[];
  cleanup?: DataApiCheck[];
}

export function readDataApi(file = "DATA-API.yaml"): DataApi {
  return parseYamlSubset(fs.readFileSync(file, "utf8")) as unknown as DataApi;
}

/** `servers[].url` of openapi.yaml (the only part of that file read here). */
export function openapiServers(file = "openapi.yaml"): string[] {
  const urls: string[] = [];
  let inServers = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\S/.test(line)) inServers = line.startsWith("servers:");
    const match = inServers && /^ {2}- url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (match) urls.push(match[1]);
  }
  return urls;
}

/** `${name}` placeholders of a DATA-API value, e.g. `${accessToken}`. */
export function placeholders(value: unknown): string[] {
  const text = JSON.stringify(value) ?? "";
  return [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
}

/** Replaces `${name}` placeholders in strings (deeply) with `vars[name]`. */
export function substitute<T>(value: T, vars: Record<string, string>): T {
  return JSON.parse(
    JSON.stringify(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
      if (!(name in vars)) throw new Error(`DATA-API: unknown variable ${whole}`);
      return JSON.stringify(vars[name]).slice(1, -1);
    }),
  ) as T;
}

/** Value at a `$.a.b` JSON path. */
export function jsonPath(body: unknown, path: string): unknown {
  if (!path.startsWith("$.")) throw new Error(`DATA-API: unsupported JSON path ${path}`);
  return path
    .slice(2)
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
      body,
    );
}

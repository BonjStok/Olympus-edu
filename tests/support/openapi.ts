// Reads the operations and response statuses declared in openapi.yaml. The file follows a fixed
// layout (two-space indentation), so a line scanner is enough and needs no YAML dependency.
import fs from "node:fs";

export type Operation = `${Uppercase<string>} ${string}`;

export function documentedStatuses(file = "openapi.yaml"): Map<Operation, Set<number>> {
  const operations = new Map<Operation, Set<number>>();
  let path = "";
  let method = "";
  let inPaths = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\S/.test(line)) inPaths = line.startsWith("paths:");
    if (!inPaths) continue;
    const pathMatch = /^ {2}(\/\S+):\s*$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(get|post|patch|put|delete):\s*$/.exec(line);
    if (methodMatch) {
      method = methodMatch[1].toUpperCase();
      operations.set(`${method} ${path}` as Operation, new Set());
      continue;
    }
    const statusMatch = /^ {8}'(\d{3})':/.exec(line);
    if (statusMatch && method)
      operations.get(`${method} ${path}` as Operation)!.add(Number(statusMatch[1]));
  }
  return operations;
}

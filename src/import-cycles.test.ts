// Guards the layer boundary between the dashboard (`dashboard-*` modules) and the domain: no
// runtime import cycle may hold modules from both sides. Cycles wholly within one side are allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dirname;
const moduleName = (file: string): string => file.replace(/\.m?ts$/, "");

/** The relative modules `source` imports or re-exports at runtime — `import type`, `export type`
 * and statements whose every named specifier is `type`-qualified are erased, so they are skipped. */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const statement = /^\s*(import|export)\s+(?:(type)\s+)?([^;]*?)\s*from\s+["']\.\/([^"'/]+)["']/gm;
  for (const m of source.matchAll(statement)) {
    if (m[2] === "type") continue;
    const clause = m[3]!;
    const braced = /^\{([\s\S]*)\}$/.exec(clause);
    if (braced) {
      const specifiers = braced[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "))) continue;
    }
    out.push(moduleName(m[4]!));
  }
  for (const m of source.matchAll(/^\s*import\s+["']\.\/([^"'/]+)["']/gm)) out.push(moduleName(m[1]!));
  return out;
}

/** Tarjan's strongly connected components over `graph`, keeping only real cycles. */
function cycles(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1 || (graph.get(v) ?? []).includes(v)) found.push(component.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

const isDashboard = (m: string): boolean => m.startsWith("dashboard-");

test("no runtime import cycle spans a dashboard-* module and a non-dashboard module", () => {
  const graph = new Map<string, string[]>();
  for (const file of readdirSync(SRC).filter((f) => /\.m?ts$/.test(f))) {
    graph.set(moduleName(file), runtimeImports(readFileSync(join(SRC, file), "utf8")));
  }
  const crossing = cycles(graph).filter((c) => c.some(isDashboard) && !c.every(isDashboard));
  assert.deepEqual(
    crossing.map((c) => c.join(", ")),
    [],
    `runtime import cycles cross the dashboard/domain layer:\n${crossing.map((c) => `  {${c.join(", ")}}`).join("\n")}`,
  );
});

test("the import scan reads runtime edges and skips type-only ones", () => {
  const source = [
    `import { a, type B } from "./alpha.ts";`,
    `import type { C } from "./beta.ts";`,
    `import { type D } from "./gamma.ts";`,
    `import {\n  e,\n  f,\n} from "./delta.ts";`,
    `export { g } from "./epsilon.ts";`,
    `export * from "./zeta.ts";`,
    `export type { H } from "./eta.ts";`,
    `import "./theta.ts";`,
    `const lazy = await import("./iota.ts");`,
  ].join("\n");
  assert.deepEqual(runtimeImports(source).sort(), ["alpha", "delta", "epsilon", "theta", "zeta"]);
});

test("the cycle finder reports only real cycles", () => {
  const graph = new Map([
    ["a", ["b"]],
    ["b", ["a", "c"]],
    ["c", []],
  ]);
  assert.deepEqual(cycles(graph), [["a", "b"]]);
});

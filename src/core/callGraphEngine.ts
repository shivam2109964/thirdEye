// src/core/callGraphEngine.ts

import type { JavaCallSite } from '../parser';

export type CallGraph = {
  nodes: Set<string>;
  adj: Map<string, Set<string>>;
  reverseAdj: Map<string, Set<string>>;
};

export function buildCallGraph(calls: JavaCallSite[]): CallGraph {
  const nodes = new Set<string>();
  const adj = new Map<string, Set<string>>();
  const reverseAdj = new Map<string, Set<string>>();

  function ensureNode(n: string) {
    if (!nodes.has(n)) nodes.add(n);
    if (!adj.has(n)) adj.set(n, new Set());
    if (!reverseAdj.has(n)) reverseAdj.set(n, new Set());
  }

  for (const c of calls) {
    const from = c.from;
    const to = c.to;

    ensureNode(from);
    ensureNode(to);

    adj.get(from)!.add(to);
    reverseAdj.get(to)!.add(from);
  }

  return { nodes, adj, reverseAdj };
}

export function dfs(
  graph: CallGraph,
  start: string
): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(node: string) {
    if (visited.has(node)) return;

    visited.add(node);
    result.push(node);

    for (const next of graph.adj.get(node) ?? []) {
      visit(next);
    }
  }

  visit(start);
  return result;
}

export function bfs(
  graph: CallGraph,
  start: string
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [start];
  const result: string[] = [];

  visited.add(start);

  while (queue.length) {
    const node = queue.shift()!;
    result.push(node);

    for (const next of graph.adj.get(node) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return result;
}

export function detectCycles(graph: CallGraph): string[][] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  function dfsCycle(node: string, path: string[]) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart));
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);

    for (const next of graph.adj.get(node) ?? []) {
      dfsCycle(next, [...path, next]);
    }

    stack.delete(node);
  }

  for (const node of graph.nodes) {
    dfsCycle(node, [node]);
  }

  return cycles;
}

export function findMissingDefinitions(
  graph: CallGraph,
  definedFunctions: string[]
): string[] {
  const defined = new Set(definedFunctions);
  const missing: string[] = [];

  for (const node of graph.nodes) {
    if (!defined.has(node)) {
      missing.push(node);
    }
  }

  return missing;
}
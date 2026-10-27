import type { GraphEdge, GraphNode, InfraGraph, NodeType } from "./types";

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  children: Map<string, GraphNode[]>;
  /** Edges touching a node, in either direction. */
  edgesOf: Map<string, GraphEdge[]>;
  root: GraphNode;
}

export function indexGraph(graph: InfraGraph): GraphIndex {
  const byId = new Map<string, GraphNode>();
  const children = new Map<string, GraphNode[]>();
  const edgesOf = new Map<string, GraphEdge[]>();
  let root: GraphNode | undefined;

  for (const node of graph.nodes) {
    byId.set(node.id, node);
    if (!node.parentId) {
      root = node;
      continue;
    }
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      const list = edgesOf.get(end);
      if (list) list.push(edge);
      else edgesOf.set(end, [edge]);
    }
  }
  if (!root) throw new Error("Graph has no root node");
  return { byId, children, edgesOf, root };
}

/** Path from the root down to `id`, inclusive. */
export function ancestry(index: GraphIndex, id: string): GraphNode[] {
  const path: GraphNode[] = [];
  for (let node = index.byId.get(id); node; node = node.parentId ? index.byId.get(node.parentId) : undefined) {
    path.unshift(node);
  }
  return path;
}

export function descendants(index: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [...(index.children.get(id) ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    stack.push(...(index.children.get(node.id) ?? []));
  }
  return out;
}

/** Containers that structure the map rather than things running in it. */
const CONTAINERS = new Set<NodeType>(["organization", "ou", "account", "region", "vpc", "subnet"]);

/** Whether a node counts as a resource in totals ("12 res"). Every view uses this, so the numbers agree. */
export function isResource(node: GraphNode): boolean {
  return !CONTAINERS.has(node.type);
}

export function countByType(nodes: Iterable<GraphNode>): Partial<Record<NodeType, number>> {
  const counts: Partial<Record<NodeType, number>> = {};
  for (const node of nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  return counts;
}

/** Structural problems in a graph; empty when valid. Used to check mock and collector output alike. */
export function validateGraph(graph: InfraGraph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  let roots = 0;

  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    ids.add(node.id);
    if (!node.parentId) roots++;
  }
  if (roots !== 1) errors.push(`expected exactly 1 root node, found ${roots}`);

  for (const node of graph.nodes) {
    if (node.parentId && !ids.has(node.parentId)) errors.push(`node ${node.id} has missing parent ${node.parentId}`);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.from)) errors.push(`edge ${edge.id} has missing source ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`edge ${edge.id} has missing target ${edge.to}`);
  }
  return errors;
}

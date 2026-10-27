import type { EdgeKind, GraphEdge, GraphNode } from "@/lib/graph/types";

/**
 * Accumulates nodes and edges discovered across many accounts and regions, then resolves references between
 * them in one pass. Collection runs in parallel, so a subnet's route to a transit gateway owned by another account
 * (or an instance in a VPC shared through RAM) may be seen before its target. Anything can therefore be named by a
 * **ref** instead of a node id:
 *
 * - a node id (ARN), or an alias registered with `add(node, { refs })`, e.g. `ec2:vpc-0abc` or `ec2:i-0abc`;
 * - `vpc-of:<ref>`: the parent of what `<ref>` names (the VPC of a subnet), for VPC-scoped resources placed by
 *   subnet such as ECS services.
 *
 * Unresolvable edges are dropped (their target is outside the collected scope); unresolvable parents fall back to the
 * node's `parentId` (normally its region node).
 */
export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly aliases = new Map<string, string>();
  private readonly parentRefs = new Map<string, string>();
  private readonly pending: { kind: EdgeKind; from: string; to: string; key?: string }[] = [];
  private readonly annotations: { ref: string; patch: (node: GraphNode) => void; orElse?: () => void }[] = [];
  private readonly endpointSubnets = new Map<string, string[]>();

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** First write wins: the same resource reported twice (e.g. by two accounts) is kept once. */
  add(node: GraphNode, options: { refs?: string[]; parentRef?: string } = {}): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) return existing;
    this.nodes.set(node.id, node);
    for (const ref of options.refs ?? []) if (!this.aliases.has(ref)) this.aliases.set(ref, node.id);
    if (options.parentRef) this.parentRefs.set(node.id, options.parentRef);
    return node;
  }

  update(id: string, patch: (node: GraphNode) => void): void {
    const node = this.nodes.get(id);
    if (node) patch(node);
  }

  /** Like `update`, but by ref and applied at build time, once every account has been collected. */
  annotate(ref: string, patch: (node: GraphNode) => void, orElse?: () => void): void {
    this.annotations.push({ ref, patch, orElse });
  }

  /** Subnets (as refs) a firewall has endpoints in: traffic routed to it leaves through their routes. */
  endpointsIn(id: string, subnetRefs: string[]): void {
    this.endpointSubnets.set(id, subnetRefs);
  }

  /** `key` identifies the underlying relationship (e.g. a peering connection id) so both sides report it once. */
  link(kind: EdgeKind, from: string, to: string, key?: string): void {
    this.pending.push({ kind, from, to, key });
  }

  private resolve(ref: string): string | undefined {
    if (ref.startsWith("vpc-of:")) {
      const inner = this.resolve(ref.slice("vpc-of:".length));
      if (!inner) return undefined;
      // The subnet's own parent ref, not its current parent: that may not have been resolved yet.
      const parentRef = this.parentRefs.get(inner);
      return (parentRef && this.resolve(parentRef)) || this.nodes.get(inner)?.parentId;
    }
    return this.nodes.has(ref) ? ref : this.aliases.get(ref);
  }

  build(options: { includeEmptyDefaultVpcs?: boolean } = {}): { nodes: GraphNode[]; edges: GraphEdge[]; dropped: number } {
    for (const [id, ref] of this.parentRefs) {
      const parent = this.resolve(ref);
      if (parent && parent !== id) this.nodes.get(id)!.parentId = parent;
    }
    for (const { ref, patch, orElse } of this.annotations) {
      const id = this.resolve(ref);
      if (id) patch(this.nodes.get(id)!);
      else orElse?.();
    }

    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const { kind, from, to, key } of this.pending) {
      const a = this.resolve(from);
      const b = this.resolve(to);
      if (!a || !b || a === b) {
        dropped++;
        continue;
      }
      const id = key ? `${kind}|${key}` : `${kind}|${a}|${b}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, kind, from: a, to: b });
    }

    const endpoints = new Map([...this.endpointSubnets].map(([id, refs]) => [id, refs.flatMap((r) => this.resolve(r) ?? [])]));
    inferSubnetTiers(this.nodes, edges, endpoints);

    const removed = new Set<string>();
    if (!options.includeEmptyDefaultVpcs) for (const id of unusedDefaultVpcs(this.nodes)) removed.add(id);
    const children = childCounts(this.nodes, removed);
    for (const node of this.nodes.values()) {
      if (node.type === "region" && !children.get(node.id)) removed.add(node.id);
    }

    const nodes = [...this.nodes.values()].filter((n) => !removed.has(n.id));
    const kept = edges.filter((e) => !removed.has(e.from) && !removed.has(e.to));
    return { nodes, edges: kept, dropped };
  }
}

const TIERS = new Set(["public", "private", "data"]);
const DATA_TIER = /(^|[^a-z])(data|db|database|isolated|rds|persistence)([^a-z]|$)/i;

/**
 * Renderers lay subnets out in public / private / data rows. AWS has no such attribute, so: an explicit `Tier`
 * tag wins; a route to an internet gateway means public, also through a firewall whose endpoint subnets route there
 * (the usual inspection design); a data-ish name means data; anything else is private.
 */
function inferSubnetTiers(nodes: Map<string, GraphNode>, edges: GraphEdge[], endpointSubnets: Map<string, string[]>): void {
  const routes = edges.filter((e) => e.kind === "routes");
  const direct = new Set(routes.filter((e) => nodes.get(e.to)?.type === "igw").map((e) => e.from));
  const toIgw = new Set(direct);
  for (const e of routes) if (endpointSubnets.get(e.to)?.some((subnet) => direct.has(subnet))) toIgw.add(e.from);
  for (const node of nodes.values()) {
    if (node.type !== "subnet") continue;
    const tagged = Object.entries(node.tags).find(([k]) => k.toLowerCase() === "tier")?.[1]?.toLowerCase();
    node.meta.tier =
      tagged && TIERS.has(tagged) ? tagged : toIgw.has(node.id) ? "public" : DATA_TIER.test(node.name) ? "data" : "private";
  }
}

/** Default VPCs (plus their subnets and internet gateway) that contain nothing else. */
function unusedDefaultVpcs(nodes: Map<string, GraphNode>): string[] {
  const kids = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    const list = kids.get(node.parentId);
    if (list) list.push(node);
    else kids.set(node.parentId, [node]);
  }
  const out: string[] = [];
  for (const vpc of nodes.values()) {
    if (vpc.type !== "vpc" || vpc.meta.isDefault !== true) continue;
    const subtree: GraphNode[] = [];
    const stack = [...(kids.get(vpc.id) ?? [])];
    while (stack.length) {
      const node = stack.pop()!;
      subtree.push(node);
      stack.push(...(kids.get(node.id) ?? []));
    }
    if (subtree.every((n) => n.type === "subnet" || n.type === "igw")) out.push(vpc.id, ...subtree.map((n) => n.id));
  }
  return out;
}

function childCounts(nodes: Map<string, GraphNode>, removed: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes.values()) {
    if (node.parentId && !removed.has(node.id)) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
  }
  return counts;
}

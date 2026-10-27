import { descendants, type GraphIndex, isResource } from "@/lib/graph/query";
import type { EdgeKind, Environment, GraphNode, InfraGraph } from "@/lib/graph/types";

export type Vec3 = [number, number, number];

// ── Org level: accounts as planets on one orbital ring per OU ───────────────

export interface Planet {
  account: GraphNode;
  env: Environment;
  position: Vec3;
  radius: number;
  ringId: string;
  resourceCount: number;
}

export interface Ring {
  id: string;
  label: string;
  radius: number;
  /** Rotation about X, applied to the ring and its planets for a less flat system. */
  tilt: number;
}

/** Aggregated cross-account relationships between two account planets. */
export interface Arc {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  count: number;
}

export interface OrgLayout {
  planets: Planet[];
  planetById: Map<string, Planet>;
  /** Any node id → id of the account node that owns it. */
  accountNodeOf: Map<string, string>;
  rings: Ring[];
  arcs: Arc[];
  /** Radius of the outermost ring. */
  extent: number;
}

const PLANET_SPACING = 30;
const RING_GAP = 28;
const FIRST_RING = 16;

export function layoutOrg(graph: InfraGraph, index: GraphIndex): OrgLayout {
  const accounts = graph.nodes.filter((n) => n.type === "account");
  const accountNodeByAccountId = new Map(accounts.map((a) => [a.accountId!, a.id]));
  const accountNodeOf = new Map<string, string>();
  for (const node of graph.nodes) {
    const owner = node.accountId && accountNodeByAccountId.get(node.accountId);
    if (owner) accountNodeOf.set(node.id, owner);
  }

  // One ring per direct parent of accounts (the org root for the management account, otherwise an OU).
  const groups = new Map<string, GraphNode[]>();
  for (const account of accounts) {
    const list = groups.get(account.parentId!);
    if (list) list.push(account);
    else groups.set(account.parentId!, [account]);
  }

  const rings: Ring[] = [];
  const planets: Planet[] = [];
  let radius = 0;
  [...groups].forEach(([parentId, members], i) => {
    radius = Math.max(i === 0 ? FIRST_RING : radius + RING_GAP, (members.length * PLANET_SPACING) / (2 * Math.PI));
    const parent = index.byId.get(parentId)!;
    const tilt = (i % 2 ? 1 : -1) * (0.06 + 0.03 * (i % 3));
    rings.push({ id: parentId, label: parent.type === "organization" ? "Root" : ouPath(index, parent), radius, tilt });

    const phase = i * 0.9;
    members.forEach((account, j) => {
      const theta = phase + (2 * Math.PI * j) / members.length;
      const x = radius * Math.cos(theta);
      const z = radius * Math.sin(theta);
      const resourceCount = descendants(index, account.id).filter(isResource).length;
      planets.push({
        account,
        env: (account.tags.Environment as Environment) ?? "shared",
        position: [x, -z * Math.sin(tilt), z * Math.cos(tilt)],
        radius: 1.4 + Math.log10(1 + resourceCount) * 0.9,
        ringId: parentId,
        resourceCount,
      });
    });
  });

  const arcCounts = new Map<string, Arc>();
  for (const edge of graph.edges) {
    const a = accountNodeOf.get(edge.from);
    const b = accountNodeOf.get(edge.to);
    if (!a || !b || a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const id = `${edge.kind}|${from}|${to}`;
    const arc = arcCounts.get(id);
    if (arc) arc.count++;
    else arcCounts.set(id, { id, kind: edge.kind, from, to, count: 1 });
  }

  return {
    planets,
    planetById: new Map(planets.map((p) => [p.account.id, p])),
    accountNodeOf,
    rings,
    arcs: [...arcCounts.values()],
    extent: radius,
  };
}

function ouPath(index: GraphIndex, ou: GraphNode): string {
  const names: string[] = [];
  for (let n: GraphNode | undefined = ou; n && n.type === "ou"; n = n.parentId ? index.byId.get(n.parentId) : undefined) {
    names.unshift(n.name);
  }
  return names.join(" / ");
}

// ── Account level: holographic stack, one layer per region ──────────────────

export type HoloRole = "layer" | "vpc" | "subnet" | "resource";

export interface HoloItem {
  node: GraphNode;
  role: HoloRole;
  /** Center, in hologram-local units. Platforms (layer/vpc/subnet) are flat boxes of `size`. */
  position: Vec3;
  size: Vec3;
}

export interface Hologram {
  items: HoloItem[];
  positionOf: Map<string, Vec3>;
  width: number;
  depth: number;
  height: number;
}

const TILE_W = 2.4;
const TILE_D = 1.6;
const GAP = 0.3;
const STRIP = 1.4;
const SLOT = 0.55;
const LAYER_GAP = 4;
const SERVICE_SLOT = 1.1;
const TIER_ORDER = ["public", "private", "data"];

export function layoutHologram(index: GraphIndex, accountNodeId: string): Hologram {
  const items: HoloItem[] = [];
  const regions = (index.children.get(accountNodeId) ?? []).filter((n) => n.type === "region");
  let width = 0;
  let depth = 0;

  regions.forEach((region, k) => {
    const y = k * LAYER_GAP;
    const layerItems: HoloItem[] = [];
    const children = index.children.get(region.id) ?? [];
    const vpcs = children.filter((n) => n.type === "vpc");
    const services = children.filter((n) => n.type !== "vpc");
    let cursor = 0;
    let layerDepth = 3;

    for (const vpc of vpcs) {
      const vpcChildren = index.children.get(vpc.id) ?? [];
      const subnets = vpcChildren.filter((n) => n.type === "subnet");
      const azs = [...new Set(subnets.map((s) => s.az!))].sort();
      const tiers = TIER_ORDER.filter((t) => subnets.some((s) => s.meta.tier === t));
      const cols = Math.max(azs.length, 1);
      const rows = Math.max(tiers.length, 1);
      const w = cols * (TILE_W + GAP) + GAP;
      const d = rows * (TILE_D + GAP) + GAP + STRIP;
      const left = cursor;
      const top = -d / 2;
      layerDepth = Math.max(layerDepth, d);
      layerItems.push({ node: vpc, role: "vpc", position: [left + w / 2, y + 0.05, 0], size: [w, 0.06, d] });

      for (const subnet of subnets) {
        const col = Math.max(azs.indexOf(subnet.az!), 0);
        const row = Math.max(tiers.indexOf(String(subnet.meta.tier)), 0);
        const tx = left + GAP + col * (TILE_W + GAP) + TILE_W / 2;
        const tz = top + GAP + row * (TILE_D + GAP) + TILE_D / 2;
        layerItems.push({ node: subnet, role: "subnet", position: [tx, y + 0.12, tz], size: [TILE_W, 0.04, TILE_D] });

        const residents = index.children.get(subnet.id) ?? [];
        const perRow = 4;
        residents.forEach((res, i) => {
          const inRow = Math.min(perRow, residents.length - Math.floor(i / perRow) * perRow);
          const rx = tx - ((inRow - 1) * SLOT) / 2 + (i % perRow) * SLOT;
          const rz = tz - ((Math.ceil(residents.length / perRow) - 1) * SLOT) / 2 + Math.floor(i / perRow) * SLOT;
          layerItems.push({ node: res, role: "resource", position: [rx, y + 0.45, rz], size: [0.32, 0.32, 0.32] });
        });
      }

      // VPC-scoped resources (load balancers, ECS services, EKS, IGW) on the front strip.
      vpcChildren
        .filter((n) => n.type !== "subnet")
        .forEach((res, i) => {
          layerItems.push({
            node: res,
            role: "resource",
            position: [left + 0.6 + i * 0.9, y + 0.45, d / 2 - STRIP / 2],
            size: [0.4, 0.4, 0.4],
          });
        });

      cursor += w + 1.5;
    }

    // Regional services (S3, SQS, DynamoDB, TGW, ...) in a two-column grid beside the VPCs.
    const serviceRows = Math.ceil(services.length / 2);
    layerDepth = Math.max(layerDepth, serviceRows * SERVICE_SLOT + 0.6);
    services.forEach((svc, i) => {
      const x = cursor + 0.5 + (i % 2) * SERVICE_SLOT;
      const z = -layerDepth / 2 + 0.6 + Math.floor(i / 2) * SERVICE_SLOT;
      layerItems.push({ node: svc, role: "resource", position: [x, y + 0.45, z], size: [0.45, 0.45, 0.45] });
    });
    const layerWidth = services.length ? cursor + 0.5 + 2 * SERVICE_SLOT : Math.max(cursor - 1.5, 2);

    for (const item of layerItems) item.position[0] -= layerWidth / 2;
    items.push({ node: region, role: "layer", position: [0, y, 0], size: [layerWidth + 2, 0.02, layerDepth + 2] });
    items.push(...layerItems);
    width = Math.max(width, layerWidth + 2);
    depth = Math.max(depth, layerDepth + 2);
  });

  return {
    items,
    positionOf: new Map(items.map((i) => [i.node.id, i.position])),
    width,
    depth,
    height: Math.max(regions.length - 1, 0) * LAYER_GAP,
  };
}

/** Where an account's hologram floats: above its planet, shrunk to fit between neighbouring planets. */
export function hologramTransform(planet: Planet, holo: Hologram): { origin: Vec3; scale: number } {
  const [x, y, z] = planet.position;
  return {
    origin: [x, y + planet.radius + 2.5, z],
    scale: Math.min(1, 14 / Math.max(holo.width, holo.depth, 1)),
  };
}

export function toWorld(origin: Vec3, scale: number, local: Vec3): Vec3 {
  return [origin[0] + local[0] * scale, origin[1] + local[1] * scale, origin[2] + local[2] * scale];
}

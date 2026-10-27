import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { GraphIndex } from "@/lib/graph/query";
import type { EdgeKind, GraphNode } from "@/lib/graph/types";

/**
 * 2D layout. elkjs packs the org → OU → account boxes (rectpacking); inside an expanded account a fixed grid
 * mirrors the classic AWS architecture diagram: region → VPC → AZ columns × tier rows of subnets → resource chips.
 * All positions are relative to `parentId`, which is exactly what React Flow sub-flows expect.
 */

export type BoxKind = "container" | "card" | "resource" | "services";

export interface Box {
  id: string;
  kind: BoxKind;
  /** Undefined only for synthetic boxes (the "regional services" group). */
  node?: GraphNode;
  parentId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** VPCs: AZ column headings, relative to the box. */
  columns?: { label: string; x: number; y: number }[];
}

/** A relationship between two visible boxes; edges into collapsed accounts are lifted to the card and merged. */
export interface FlatEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  count: number;
}

export interface FlatLayout {
  boxes: Box[];
  edges: FlatEdge[];
}

export const CARD_W = 248;
export const CARD_H = 104;
export const CHIP_H = 26;
const CHIP_W = 184;
const CHIP_GAP = 6;
const SUB_W = 200;
const SUB_HEADER = 30;
const SUB_PAD = 8;
const GRID_GAP = 12;
const VPC_PAD = 14;
const VPC_HEADER = 36;
const AZ_LABEL = 18;
const REGION_PAD = 16;
const REGION_HEADER = 36;
const SERVICES_HEADER = 26;
const ITEM_GAP = 20;
const ACCOUNT_PAD = 18;
export const ACCOUNT_HEADER = 48;
const TIER_ORDER = ["public", "private", "data"];

const elk = new ELK();

export async function layoutFlat(index: GraphIndex, expanded: ReadonlySet<string>): Promise<FlatLayout> {
  const inner = new Map<string, Inner>();
  for (const id of expanded) {
    const account = index.byId.get(id);
    if (account?.type === "account") inner.set(id, layoutAccount(index, account));
  }

  const toElk = (node: GraphNode): ElkNode => {
    if (node.type === "account") {
      const detail = inner.get(node.id);
      return { id: node.id, width: detail?.w ?? CARD_W, height: detail?.h ?? CARD_H };
    }
    const kids = (index.children.get(node.id) ?? []).filter((n) => n.type === "ou" || n.type === "account");
    return {
      id: node.id,
      layoutOptions: {
        "elk.algorithm": "rectpacking",
        "elk.padding": "[top=52,left=24,bottom=24,right=24]",
        "elk.spacing.nodeNode": "28",
        "elk.aspectRatio": node.type === "organization" ? "1.8" : "1.6",
      },
      // Keep empty OUs visible and labelled.
      ...(kids.length ? { children: kids.map(toElk) } : { width: CARD_W, height: 80 }),
    };
  };

  const root = await elk.layout(toElk(index.root));
  const boxes: Box[] = [];

  const walk = (elkNode: ElkNode, parentId?: string) => {
    const node = index.byId.get(elkNode.id)!;
    const detail = inner.get(node.id);
    boxes.push({
      id: node.id,
      kind: node.type === "account" && !detail ? "card" : "container",
      node,
      parentId,
      x: elkNode.x ?? 0,
      y: elkNode.y ?? 0,
      w: elkNode.width ?? CARD_W,
      h: elkNode.height ?? CARD_H,
    });
    if (detail) boxes.push(...detail.children);
    for (const child of elkNode.children ?? []) walk(child, node.id);
  };
  walk(root);

  return { boxes, edges: liftEdges(index, boxes) };
}

function liftEdges(index: GraphIndex, boxes: Box[]): FlatEdge[] {
  const visible = new Set(boxes.filter((b) => b.node).map((b) => b.id));
  const representative = (id: string): string | undefined => {
    for (let n = index.byId.get(id); n; n = n.parentId ? index.byId.get(n.parentId) : undefined) {
      if (visible.has(n.id)) return n.id;
    }
  };

  const merged = new Map<string, FlatEdge>();
  const seen = new Set<string>();
  // edgesOf lists every edge under both endpoints; count each once.
  for (const edges of index.edgesOf.values()) {
    for (const edge of edges) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      const source = representative(edge.from);
      const target = representative(edge.to);
      if (!source || !target || source === target) continue;
      const id = `${edge.kind}|${source}|${target}`;
      const existing = merged.get(id);
      if (existing) existing.count++;
      else merged.set(id, { id, kind: edge.kind, source, target, count: 1 });
    }
  }
  return [...merged.values()];
}

/** A box's rectangle in flow coordinates (positions are stored parent-relative). */
export function absoluteRect(boxes: Box[], id: string): { x: number; y: number; width: number; height: number } | null {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const box = byId.get(id);
  if (!box) return null;
  let x = box.x;
  let y = box.y;
  for (let p = box.parentId ? byId.get(box.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
    x += p.x;
    y += p.y;
  }
  return { x, y, width: box.w, height: box.h };
}

// ── Account interior ───────────────────────────────────────────────────────

interface Inner {
  children: Box[];
  w: number;
  h: number;
}

const kidsOf = (index: GraphIndex, id: string) => index.children.get(id) ?? [];

function chips(nodes: GraphNode[], parentId: string, x: number, y: number, w: number, perRow = 1): Box[] {
  return nodes.map((node, i) => ({
    id: node.id,
    kind: "resource",
    node,
    parentId,
    x: x + (i % perRow) * (w + GRID_GAP),
    y: y + Math.floor(i / perRow) * (CHIP_H + CHIP_GAP),
    w,
    h: CHIP_H,
  }));
}

const stackHeight = (n: number) => (n ? n * (CHIP_H + CHIP_GAP) - CHIP_GAP : 0);

function layoutAccount(index: GraphIndex, account: GraphNode): Inner {
  const children: Box[] = [];
  let x = ACCOUNT_PAD;
  let tallest = 0;
  for (const region of kidsOf(index, account.id).filter((n) => n.type === "region")) {
    const r = layoutRegion(index, region);
    children.push({ id: region.id, kind: "container", node: region, parentId: account.id, x, y: ACCOUNT_HEADER, w: r.w, h: r.h });
    children.push(...r.children);
    x += r.w + ITEM_GAP;
    tallest = Math.max(tallest, r.h);
  }
  if (!children.length) return { children, w: CARD_W, h: CARD_H };
  return { children, w: Math.max(CARD_W, x - ITEM_GAP + ACCOUNT_PAD), h: ACCOUNT_HEADER + tallest + ACCOUNT_PAD };
}

function layoutRegion(index: GraphIndex, region: GraphNode): Inner {
  const children: Box[] = [];
  const kids = kidsOf(index, region.id);
  let x = REGION_PAD;
  let tallest = 0;

  for (const vpc of kids.filter((n) => n.type === "vpc")) {
    const v = layoutVpc(index, vpc);
    children.push({ id: vpc.id, kind: "container", node: vpc, parentId: region.id, x, y: REGION_HEADER, w: v.w, h: v.h, columns: v.columns });
    children.push(...v.children);
    x += v.w + ITEM_GAP;
    tallest = Math.max(tallest, v.h);
  }

  const services = kids.filter((n) => n.type !== "vpc");
  if (services.length) {
    const id = `${region.id}#services`;
    const w = CHIP_W + 2 * SUB_PAD;
    const h = SERVICES_HEADER + stackHeight(services.length) + SUB_PAD;
    children.push({ id, kind: "services", parentId: region.id, x, y: REGION_HEADER, w, h });
    children.push(...chips(services, id, SUB_PAD, SERVICES_HEADER, CHIP_W));
    x += w + ITEM_GAP;
    tallest = Math.max(tallest, h);
  }

  return { children, w: Math.max(x - ITEM_GAP, 0) + REGION_PAD, h: REGION_HEADER + tallest + REGION_PAD };
}

function layoutVpc(index: GraphIndex, vpc: GraphNode): Inner & { columns: Box["columns"] } {
  const children: Box[] = [];
  const kids = kidsOf(index, vpc.id);
  const subnets = kids.filter((n) => n.type === "subnet");
  const azs = [...new Set(subnets.map((s) => s.az!))].sort();
  const tiers = TIER_ORDER.filter((t) => subnets.some((s) => s.meta.tier === t));
  const cols = Math.max(azs.length, 1);
  const innerW = cols * SUB_W + (cols - 1) * GRID_GAP;

  // VPC-scoped resources (load balancers, ECS services, EKS, IGW) in a strip above the subnet grid.
  const strip = kids.filter((n) => n.type !== "subnet");
  const perRow = Math.max(1, Math.floor((innerW + GRID_GAP) / (CHIP_W + GRID_GAP)));
  children.push(...chips(strip, vpc.id, VPC_PAD, VPC_HEADER, CHIP_W, perRow));
  const stripH = strip.length ? Math.ceil(strip.length / perRow) * (CHIP_H + CHIP_GAP) + 6 : 0;
  const columnsY = VPC_HEADER + stripH;
  const gridTop = columnsY + AZ_LABEL;

  const cell = (s: GraphNode) => ({ col: Math.max(azs.indexOf(s.az!), 0), row: Math.max(tiers.indexOf(String(s.meta.tier)), 0) });
  const rowHeights = tiers.map((_, row) =>
    Math.max(
      SUB_HEADER + CHIP_H + SUB_PAD,
      ...subnets.filter((s) => cell(s).row === row).map((s) => SUB_HEADER + stackHeight(kidsOf(index, s.id).length) + SUB_PAD),
    ),
  );
  const rowTop = (row: number) => gridTop + rowHeights.slice(0, row).reduce((a, b) => a + b, 0) + row * GRID_GAP;

  for (const subnet of subnets) {
    const { col, row } = cell(subnet);
    const x = VPC_PAD + col * (SUB_W + GRID_GAP);
    children.push({ id: subnet.id, kind: "container", node: subnet, parentId: vpc.id, x, y: rowTop(row), w: SUB_W, h: rowHeights[row] ?? SUB_HEADER });
    children.push(...chips(kidsOf(index, subnet.id), subnet.id, SUB_PAD, SUB_HEADER, SUB_W - 2 * SUB_PAD));
  }

  const gridH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(rowHeights.length - 1, 0) * GRID_GAP;
  return {
    children,
    w: innerW + 2 * VPC_PAD,
    h: gridTop + gridH + VPC_PAD,
    columns: azs.map((az, c) => ({ label: az, x: VPC_PAD + c * (SUB_W + GRID_GAP), y: columnsY })),
  };
}

import type { GraphNode, InfraGraph } from "./types";

/**
 * Spend in a snapshot: flat `meta.cost*` keys written by the AWS collector's Cost Explorer step (and the mock
 * generator). Accounts and regions carry `costMonthToDate` / `costLastMonth`; accounts also `costTopServices`;
 * the organization root the totals plus currency, metric and period. No keys: costs weren't collected (or the
 * server hides them, see `stripCosts`).
 */

export interface NodeCost {
  monthToDate: number;
  lastMonth: number;
}

export interface CostSummary extends NodeCost {
  currency: string;
  metric: string;
  from: string;
  through: string;
  /** Collected accounts with figures; with costs read from a non-payer account, only that one. */
  accounts: number;
}

export function nodeCost(node: GraphNode | undefined): NodeCost | undefined {
  const monthToDate = node?.meta.costMonthToDate;
  const lastMonth = node?.meta.costLastMonth;
  if (typeof monthToDate !== "number" || typeof lastMonth !== "number") return undefined;
  return { monthToDate, lastMonth };
}

export function costSummary(root: GraphNode): CostSummary | undefined {
  const cost = nodeCost(root);
  if (!cost) return undefined;
  const text = (key: string) => String(root.meta[key] ?? "");
  return {
    ...cost,
    currency: text("costCurrency") || "USD",
    metric: text("costMetric"),
    from: text("costFrom"),
    through: text("costThrough"),
    accounts: Number(root.meta.costAccounts ?? 0),
  };
}

export const cents = (amount: number) => Math.round(amount * 100) / 100;

/** "Amazon EC2 12.30; Amazon S3 1.20; … +4": the biggest few, then a count. */
export function formatTopServices(services: Iterable<[string, number]>, limit = 5): string {
  const sorted = [...services].filter(([, amount]) => cents(amount) > 0).sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, limit).map(([service, amount]) => `${service} ${cents(amount).toFixed(2)}`);
  return shown.join("; ") + (sorted.length > limit ? `; … +${sorted.length - limit}` : "");
}

/** Inverse of `formatTopServices`, for display; the trailing "… +N" comes back as `more`. */
export function parseTopServices(value: GraphNode["meta"][string] | undefined): { services: [string, number][]; more: number } {
  const services: [string, number][] = [];
  let more = 0;
  for (const part of String(value ?? "").split("; ")) {
    const rest = /^… \+(\d+)$/.exec(part);
    if (rest) more = Number(rest[1]);
    const m = /^(.*) (-?\d+(?:\.\d+)?)$/.exec(part);
    if (!rest && m) services.push([m[1], Number(m[2])]);
  }
  return { services, more };
}

/** `$1,234.56`, or compact (`$12.3K`) for tight spots. */
export function formatMoney(amount: number, currency = "USD", compact = false): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: compact && Math.abs(amount) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: compact && Math.abs(amount) >= 10_000 ? 1 : 2,
      minimumFractionDigits: compact && Math.abs(amount) >= 10_000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Whether a meta key is one of the cost keys. */
export const isCostKey = (key: string) => /^cost[A-Z]/.test(key);

/** The graph without any cost data, for servers configured not to show it (`ui.costs: false`). */
export function stripCosts(graph: InfraGraph): InfraGraph {
  if (!graph.nodes.some((n) => Object.keys(n.meta).some(isCostKey))) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const keys = Object.keys(node.meta);
      if (!keys.some(isCostKey)) return node;
      return { ...node, meta: Object.fromEntries(Object.entries(node.meta).filter(([k]) => !isCostKey(k))) };
    }),
  };
}

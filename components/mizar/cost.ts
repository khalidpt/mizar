import { type CostSummary, costSummary, formatMoney, nodeCost } from "@/lib/graph/cost";
import type { Environment, GraphNode, InfraGraph } from "@/lib/graph/types";
import { ENV_COLOR, STATUS_COLOR } from "./theme";

/**
 * One-hue sequential ramp (blue, dark → light on the dark background: more spend reads brighter). Starts at a
 * step that still stands out from the background, and stays clear of the status colours (amber, red).
 */
export const COST_RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb"];
/** Accounts without figures (costs read from a non-payer account, or a new account). */
export const NO_COST = "#334155";

export type ColorBy = "environment" | "cost";

export interface CostScale {
  summary: CostSummary;
  /** Month to date, or last month on the 1st (nothing of this month is in yet). */
  period: "monthToDate" | "lastMonth";
  /** Smallest non-zero and biggest account figure for `period`: the ends of the ramp. */
  min: number;
  max: number;
}

export function costScale(graph: InfraGraph, root: GraphNode): CostScale | null {
  const summary = costSummary(root);
  if (!summary) return null;
  const accounts = graph.nodes.filter((n) => n.type === "account").map(nodeCost);
  const amounts = (period: CostScale["period"]) => accounts.map((c) => c?.[period] ?? 0).filter((a) => a > 0);
  const period = amounts("monthToDate").length ? "monthToDate" : "lastMonth";
  const spent = amounts(period);
  return { summary, period, min: spent.length ? Math.min(...spent) : 0, max: spent.length ? Math.max(...spent) : 0 };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Position on the ramp, log scale (spend spans orders of magnitude) from the cheapest account that spent anything
 * (0) to the biggest (1); nothing spent is 0 too. Anchoring at zero instead would crowd most accounts at the top.
 */
export function costShare(scale: CostScale, amount: number): number {
  if (amount <= scale.min || scale.max <= scale.min) return amount > 0 && scale.max === scale.min ? 1 : 0;
  return Math.min(1, Math.log(amount / scale.min) / Math.log(scale.max / scale.min));
}

export function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (COST_RAMP.length - 1);
  const i = Math.min(COST_RAMP.length - 2, Math.floor(x));
  const [a, b] = [rgb(COST_RAMP[i]), rgb(COST_RAMP[i + 1])];
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * (x - i)).toString(16).padStart(2, "0")).join("")}`;
}

/** Compact spend with its period, for labels: "$1,033.97 mtd", or "… last mo" on the 1st. */
export function spendLabel(scale: CostScale | null, node: GraphNode): string | undefined {
  const spend = scale ? nodeCost(node) : undefined;
  if (!scale || !spend) return undefined;
  return `${formatMoney(spend[scale.period], scale.summary.currency, true)} ${scale.period === "monthToDate" ? "mtd" : "last mo"}`;
}

/** An account's colour in either mode; suspended accounts stay grey in both. */
export function accountColor(account: GraphNode, env: Environment, colorBy: ColorBy, scale: CostScale | null): string {
  if (account.status === "stopped") return STATUS_COLOR.stopped;
  if (colorBy === "environment" || !scale) return ENV_COLOR[env];
  const cost = nodeCost(account);
  return cost ? rampColor(costShare(scale, cost[scale.period])) : NO_COST;
}

import { type CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandInput, type ResultByTime } from "@aws-sdk/client-cost-explorer";
import type { MizarConfig } from "@/lib/config";
import { cents, formatTopServices } from "@/lib/graph/cost";
import type { GraphNode } from "@/lib/graph/types";
import type { GraphBuilder } from "./builder";
import type { Target } from "./org";

/**
 * Spend from Cost Explorer, read once per collection from one account (the management account sees every linked
 * account; any other account only itself). Two grouped queries, a cent each (more only when results page):
 *
 * - last month and month to date by account × region → `costLastMonth` / `costMonthToDate` on accounts and regions;
 * - month to date by account × service → the top services on each account (`costTopServices`).
 *
 * Credits and refunds are left out, so the figures are what resources cost, not what the invoice says. Region spend
 * outside a drawn region (`global`, `NoRegion`, a region with nothing mapped) still counts towards the account.
 */

type CostMetric = MizarConfig["aws"]["cost"]["metric"];
type Month = "lastMonth" | "monthToDate";

export interface CostReport {
  metric: CostMetric;
  currency: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  through: string;
  /** Cost Explorer requests made (each one billed). */
  requests: number;
  /** accountId → region → month → amount. */
  regions: Map<string, Map<string, Record<Month, number>>>;
  /** accountId → service → month-to-date amount. */
  services: Map<string, Map<string, number>>;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** Calendar periods in UTC, which is how Cost Explorer reports. `end` is exclusive (today: complete days only). */
export function costPeriods(now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { lastMonthStart: day(lastMonthStart), monthStart: day(monthStart), end: day(end), through: day(new Date(end.getTime() - 86_400_000)) };
}

async function query(client: CostExplorerClient, input: GetCostAndUsageCommandInput, count: () => void): Promise<ResultByTime[]> {
  const out: ResultByTime[] = [];
  let token: string | undefined;
  do {
    count();
    const response = await client.send(new GetCostAndUsageCommand({ ...input, NextPageToken: token }));
    out.push(...(response.ResultsByTime ?? []));
    token = response.NextPageToken;
  } while (token);
  return out;
}

export async function queryCosts(client: CostExplorerClient, metric: CostMetric, now = new Date()): Promise<CostReport> {
  const { lastMonthStart, monthStart, end, through } = costPeriods(now);
  const base = {
    Granularity: "MONTHLY",
    Metrics: [metric],
    Filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } },
  } satisfies Partial<GetCostAndUsageCommandInput>;
  const groupBy = (key: string) => [{ Type: "DIMENSION" as const, Key: "LINKED_ACCOUNT" }, { Type: "DIMENSION" as const, Key: key }];

  let requests = 0;
  const count = () => void requests++;
  // On the 1st nothing of this month is complete yet: the month to date is empty, by service too.
  const [byRegion, byService] = await Promise.all([
    query(client, { ...base, TimePeriod: { Start: lastMonthStart, End: end }, GroupBy: groupBy("REGION") }, count),
    end > monthStart ? query(client, { ...base, TimePeriod: { Start: monthStart, End: end }, GroupBy: groupBy("SERVICE") }, count) : [],
  ]);

  const report: CostReport = { metric, currency: "", from: lastMonthStart, through, requests, regions: new Map(), services: new Map() };
  const amounts = (result: ResultByTime, visit: (account: string, key: string, amount: number) => void) => {
    for (const group of result.Groups ?? []) {
      const [account, key] = group.Keys ?? [];
      const value = group.Metrics?.[metric];
      const amount = Number(value?.Amount);
      if (!account || !Number.isFinite(amount)) continue;
      if (value?.Unit && !report.currency) report.currency = value.Unit;
      visit(account, key || "NoRegion", amount);
    }
  };

  for (const result of byRegion) {
    const month: Month = result.TimePeriod?.Start === monthStart ? "monthToDate" : "lastMonth";
    amounts(result, (account, region, amount) => {
      const regions = report.regions.get(account) ?? new Map<string, Record<Month, number>>();
      report.regions.set(account, regions);
      const entry = regions.get(region) ?? { lastMonth: 0, monthToDate: 0 };
      regions.set(region, entry);
      entry[month] += amount;
    });
  }
  for (const result of byService) {
    amounts(result, (account, service, amount) => {
      const services = report.services.get(account) ?? new Map<string, number>();
      report.services.set(account, services);
      services.set(service, (services.get(service) ?? 0) + amount);
    });
  }
  return report;
}

/**
 * Writes the report onto the collected accounts, their regions and the organization root (totals of the collected
 * accounts only). Applied at build time, so regions found later still get theirs.
 *
 * Read from the management account (or whenever the report names other accounts, which only a payer sees), accounts
 * without spend get zeros; read from any other account, only that account is known.
 */
export function applyCosts(
  b: GraphBuilder,
  report: CostReport,
  targets: readonly Target[],
  root: GraphNode,
  costAccountId: string,
): void {
  const payer = root.meta.managementAccountId === costAccountId || [...report.regions.keys()].some((id) => id !== costAccountId);
  const covered = targets.filter((t) => payer || t.accountId === costAccountId);
  const total = { lastMonth: 0, monthToDate: 0 };
  for (const target of covered) {
    const regions = report.regions.get(target.accountId) ?? new Map<string, Record<Month, number>>();
    const account = { lastMonth: 0, monthToDate: 0 };
    for (const [region, amounts] of regions) {
      account.lastMonth += amounts.lastMonth;
      account.monthToDate += amounts.monthToDate;
      b.annotate(`region/${target.accountId}/${region}`, (node) => {
        node.meta.costMonthToDate = cents(amounts.monthToDate);
        node.meta.costLastMonth = cents(amounts.lastMonth);
      });
    }
    total.lastMonth += account.lastMonth;
    total.monthToDate += account.monthToDate;
    const services = formatTopServices(report.services.get(target.accountId) ?? []);
    b.annotate(target.nodeId, (node) => {
      node.meta.costMonthToDate = cents(account.monthToDate);
      node.meta.costLastMonth = cents(account.lastMonth);
      if (services) node.meta.costTopServices = services;
    });
  }
  b.annotate(root.id, (node) => {
    node.meta.costMonthToDate = cents(total.monthToDate);
    node.meta.costLastMonth = cents(total.lastMonth);
    node.meta.costCurrency = report.currency || "USD";
    node.meta.costMetric = report.metric;
    node.meta.costFrom = report.from;
    node.meta.costThrough = report.through;
    node.meta.costAccounts = covered.length;
  });
}

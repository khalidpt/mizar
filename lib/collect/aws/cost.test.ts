import assert from "node:assert/strict";
import { test } from "node:test";
import type { GetCostAndUsageCommandInput, GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import type { GraphNode } from "@/lib/graph/types";
import { GraphBuilder } from "./builder";
import { applyCosts, costPeriods, queryCosts } from "./cost";
import type { Target } from "./org";
import { costExplorerClient } from "./session";

const MGMT = "111111111111";
const B = "222222222222";
const C = "333333333333";
const NOW = new Date("2026-10-20T13:00:00Z");

const node = (id: string, type: GraphNode["type"], parentId?: string, meta: GraphNode["meta"] = {}): GraphNode => ({
  id,
  type,
  name: id,
  parentId,
  status: "ok",
  tags: {},
  meta,
});
const accountId = (id: string) => `arn:aws:organizations::${MGMT}:account/o-x/${id}`;
const targets: Target[] = [MGMT, B, C].map((id) => ({ accountId: id, nodeId: accountId(id), name: id }));

function graph() {
  const b = new GraphBuilder();
  const root = b.add(node("org", "organization", undefined, { managementAccountId: MGMT }));
  for (const t of targets) b.add(node(t.nodeId, "account", "org"));
  b.add(node(`region/${B}/eu-west-1`, "region", accountId(B)));
  b.add(node("vpc", "vpc", `region/${B}/eu-west-1`));
  return { b, root };
}

const group = (account: string, key: string, amount: string) => ({ Keys: [account, key], Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } } });

/** A real client whose `send` answers by the query's second group-by dimension, recording every request. */
function fakeCostExplorer(pages: Record<string, GetCostAndUsageCommandOutput["ResultsByTime"][]>) {
  const client = costExplorerClient("us-east-1", async () => ({ accessKeyId: "test", secretAccessKey: "test" }));
  const requests: GetCostAndUsageCommandInput[] = [];
  (client as unknown as { send: (cmd: { input: GetCostAndUsageCommandInput }) => Promise<unknown> }).send = async ({ input }) => {
    requests.push(input);
    const key = input.GroupBy![1].Key!;
    const page = Number(input.NextPageToken ?? 0);
    return { ResultsByTime: pages[key][page], NextPageToken: page + 1 < pages[key].length ? String(page + 1) : undefined };
  };
  return { client, requests };
}

const lastMonth = { Start: "2026-09-01", End: "2026-10-01" };
const thisMonth = { Start: "2026-10-01", End: "2026-10-20" };

test("periods are UTC calendar months, ending with the last complete day", () => {
  assert.deepEqual(costPeriods(NOW), { lastMonthStart: "2026-09-01", monthStart: "2026-10-01", end: "2026-10-20", through: "2026-10-19" });
  assert.deepEqual(costPeriods(new Date("2026-01-01T00:30:00Z")), {
    lastMonthStart: "2025-12-01",
    monthStart: "2026-01-01",
    end: "2026-01-01",
    through: "2025-12-31",
  });
});

test("two grouped queries, paged, without credits and refunds", async () => {
  const { client, requests } = fakeCostExplorer({
    REGION: [
      [{ TimePeriod: lastMonth, Groups: [group(B, "eu-west-1", "40.004"), group(B, "global", "2")] }],
      [{ TimePeriod: thisMonth, Groups: [group(B, "eu-west-1", "10.5"), group(C, "", "0.25")] }],
    ],
    SERVICE: [[{ TimePeriod: thisMonth, Groups: [group(B, "Amazon EC2", "9"), group(B, "Amazon S3", "1.5")] }]],
  });
  const report = await queryCosts(client, "UnblendedCost", NOW);

  assert.equal(requests.length, 3);
  assert.equal(report.requests, 3);
  assert.deepEqual(requests[0].TimePeriod, { Start: "2026-09-01", End: "2026-10-20" });
  assert.deepEqual(requests.find((r) => r.GroupBy![1].Key === "SERVICE")!.TimePeriod, thisMonth);
  for (const r of requests) {
    assert.equal(r.Granularity, "MONTHLY");
    assert.deepEqual(r.Metrics, ["UnblendedCost"]);
    assert.deepEqual(r.Filter, { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } });
  }

  assert.equal(report.currency, "USD");
  assert.equal(report.through, "2026-10-19");
  assert.deepEqual(report.regions.get(B)?.get("eu-west-1"), { lastMonth: 40.004, monthToDate: 10.5 });
  assert.deepEqual(report.regions.get(B)?.get("global"), { lastMonth: 2, monthToDate: 0 });
  assert.deepEqual(report.regions.get(C)?.get("NoRegion"), { lastMonth: 0, monthToDate: 0.25 });
  assert.equal(report.services.get(B)?.get("Amazon EC2"), 9);
});

test("on the 1st only last month is queried", async () => {
  const { client, requests } = fakeCostExplorer({ REGION: [[{ TimePeriod: lastMonth, Groups: [group(B, "eu-west-1", "3")] }]], SERVICE: [] });
  const report = await queryCosts(client, "UnblendedCost", new Date("2026-10-01T08:00:00Z"));
  assert.equal(requests.length, 1);
  assert.deepEqual(report.regions.get(B)?.get("eu-west-1"), { lastMonth: 3, monthToDate: 0 });
});

const report = {
  metric: "UnblendedCost" as const,
  currency: "USD",
  from: "2026-09-01",
  through: "2026-10-19",
  requests: 2,
  regions: new Map([
    [B, new Map([["eu-west-1", { lastMonth: 40.004, monthToDate: 10.5 }], ["global", { lastMonth: 2, monthToDate: 0 }]])],
    ["999999999999", new Map([["us-east-1", { lastMonth: 1000, monthToDate: 1000 }]])],
  ]),
  services: new Map([[B, new Map(Object.entries({ "Amazon EC2": 9, "Amazon S3": 1.5, AWS: 0.001, a: 1, b: 1, c: 1, d: 1 }))]]),
};

test("from the payer: every collected account, its drawn regions and the organization total", () => {
  const { b, root } = graph();
  applyCosts(b, report, targets, root, MGMT);
  const nodes = new Map(b.build().nodes.map((n) => [n.id, n]));

  const account = nodes.get(accountId(B))!.meta;
  assert.equal(account.costLastMonth, 42);
  assert.equal(account.costMonthToDate, 10.5);
  assert.equal(account.costTopServices, "Amazon EC2 9.00; Amazon S3 1.50; a 1.00; b 1.00; c 1.00; … +1");
  assert.deepEqual(nodes.get(`region/${B}/eu-west-1`)!.meta, { costMonthToDate: 10.5, costLastMonth: 40 });
  // No spend reported: zeros, and no services line.
  assert.equal(nodes.get(accountId(C))!.meta.costLastMonth, 0);
  assert.equal(nodes.get(accountId(C))!.meta.costTopServices, undefined);

  // Accounts outside the collected scope don't count.
  assert.deepEqual(
    { ...nodes.get("org")!.meta, managementAccountId: undefined },
    {
      managementAccountId: undefined,
      costMonthToDate: 10.5,
      costLastMonth: 42,
      costCurrency: "USD",
      costMetric: "UnblendedCost",
      costFrom: "2026-09-01",
      costThrough: "2026-10-19",
      costAccounts: 3,
    },
  );
});

test("from a member account: only that account is known", () => {
  const { b, root } = graph();
  const own = { ...report, regions: new Map([[B, report.regions.get(B)!]]) };
  applyCosts(b, own, targets, root, B);
  const nodes = new Map(b.build().nodes.map((n) => [n.id, n]));

  assert.equal(nodes.get(accountId(B))!.meta.costLastMonth, 42);
  assert.equal(nodes.get(accountId(C))!.meta.costLastMonth, undefined);
  assert.equal(nodes.get(accountId(MGMT))!.meta.costLastMonth, undefined);
  assert.equal(nodes.get("org")!.meta.costAccounts, 1);
});

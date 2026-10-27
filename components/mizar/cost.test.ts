import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMockGraph } from "@/lib/graph/mock";
import { accountColor, COST_RAMP, costScale, costShare, NO_COST, rampColor, spendLabel } from "./cost";
import { ENV_COLOR, STATUS_COLOR } from "./theme";

const graph = generateMockGraph();
const root = graph.nodes.find((n) => !n.parentId)!;
const accounts = graph.nodes.filter((n) => n.type === "account");

test("the ramp runs from its first to its last step", () => {
  assert.equal(rampColor(0), COST_RAMP[0]);
  assert.equal(rampColor(1), COST_RAMP.at(-1));
  assert.equal(rampColor(0.5), COST_RAMP[5]);
  assert.equal(rampColor(-1), COST_RAMP[0]);
});

test("the scale runs from the cheapest to the biggest account, on a log scale", () => {
  const scale = costScale(graph, root)!;
  assert.equal(scale.period, "monthToDate");
  const spent = accounts.map((a) => Number(a.meta.costMonthToDate)).filter((a) => a > 0);
  assert.equal(scale.max, Math.max(...spent));
  assert.equal(scale.min, Math.min(...spent));
  assert.equal(costShare(scale, scale.max), 1);
  assert.equal(costShare(scale, scale.min), 0);
  assert.equal(costShare(scale, 0), 0);
  const middle = Math.sqrt(scale.min * scale.max);
  assert.ok(Math.abs(costShare(scale, middle) - 0.5) < 1e-9, "the geometric mean sits mid-ramp");
  assert.equal(costShare({ ...scale, min: 5, max: 5 }, 5), 1, "a single spender is at the top");
  const free = generateMockGraph({ costs: false });
  assert.equal(costScale(free, free.nodes.find((n) => !n.parentId)!), null);
});

test("account colours by mode", () => {
  const scale = costScale(graph, root)!;
  const prod = accounts.find((a) => a.name === "payments-prod")!;
  const suspended = accounts.find((a) => a.status === "stopped")!;
  assert.equal(accountColor(prod, "prod", "environment", scale), ENV_COLOR.prod);
  assert.match(accountColor(prod, "prod", "cost", scale), /^#[0-9a-f]{6}$/);
  assert.equal(accountColor(suspended, "prod", "cost", scale), STATUS_COLOR.stopped);
  const unknown = { ...prod, meta: {} };
  assert.equal(accountColor(unknown, "prod", "cost", scale), NO_COST);
  assert.equal(accountColor(prod, "prod", "cost", null), ENV_COLOR.prod, "no costs: environment colours");
});

test("spend labels name their period", () => {
  const scale = costScale(graph, root)!;
  const prod = accounts.find((a) => a.name === "payments-prod")!;
  assert.match(spendLabel(scale, prod)!, /^\$[\d,.]+K? mtd$/);
  assert.match(spendLabel({ ...scale, period: "lastMonth" }, prod)!, / last mo$/);
  assert.equal(spendLabel(null, prod), undefined);
  assert.equal(spendLabel(scale, { ...prod, meta: {} }), undefined);
});

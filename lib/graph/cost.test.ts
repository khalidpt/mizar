import assert from "node:assert/strict";
import { test } from "node:test";
import { costSummary, formatMoney, formatTopServices, nodeCost, parseTopServices, stripCosts } from "./cost";
import { generateMockGraph } from "./mock";
import { checkSnapshot } from "./schema";

test("top services survive a round trip", () => {
  const text = formatTopServices([["Amazon EC2", 9], ["EC2 - Other", 12.345], ["Tiny", 0.001], ["a", 1], ["b", 1], ["c", 1]]);
  assert.equal(text, "EC2 - Other 12.35; Amazon EC2 9.00; a 1.00; b 1.00; c 1.00");
  assert.deepEqual(parseTopServices(`${text}; … +3`), {
    services: [["EC2 - Other", 12.35], ["Amazon EC2", 9], ["a", 1], ["b", 1], ["c", 1]],
    more: 3,
  });
  assert.deepEqual(parseTopServices(undefined), { services: [], more: 0 });
});

test("money is formatted, compactly when asked", () => {
  assert.equal(formatMoney(1234.5), "$1,234.50");
  assert.equal(formatMoney(17268.14, "USD", true), "$17.3K");
  assert.equal(formatMoney(8.62, "USD", true), "$8.62");
  assert.equal(formatMoney(3, "EUR"), "€3.00");
});

test("the mock org carries consistent, valid costs", () => {
  const graph = generateMockGraph();
  assert.deepEqual(checkSnapshot(graph), []);
  const root = graph.nodes.find((n) => !n.parentId)!;
  const summary = costSummary(root)!;
  const accounts = graph.nodes.filter((n) => n.type === "account");
  assert.equal(summary.accounts, accounts.length);
  const sum = accounts.reduce((total, a) => total + nodeCost(a)!.lastMonth, 0);
  assert.ok(Math.abs(sum - summary.lastMonth) < 0.05 * accounts.length, "root total is the sum of accounts");
  assert.ok(summary.monthToDate < summary.lastMonth, "mid-month: less than a full month");
});

test("stripCosts removes every cost key and nothing else", () => {
  const graph = generateMockGraph();
  const stripped = stripCosts(graph);
  assert.ok(stripped.nodes.every((n) => !Object.keys(n.meta).some((k) => k.startsWith("cost"))));
  assert.deepEqual(stripped, generateMockGraph({ costs: false }));
  assert.ok(nodeCost(graph.nodes.find((n) => n.type === "account")), "the input is left alone");
  const without = generateMockGraph({ costs: false });
  assert.equal(stripCosts(without), without);
});

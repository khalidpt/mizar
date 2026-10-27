import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMockGraph } from "./mock";
import { descendants, indexGraph, isResource } from "./query";

test("isResource excludes containers, so per-account totals add up to the org total", () => {
  const graph = generateMockGraph();
  const index = indexGraph(graph);
  const total = graph.nodes.filter(isResource).length;
  const perAccount = graph.nodes
    .filter((n) => n.type === "account")
    .reduce((sum, account) => sum + descendants(index, account.id).filter(isResource).length, 0);
  assert.equal(perAccount, total);
  assert.ok(!graph.nodes.some((n) => isResource(n) && ["organization", "ou", "account", "region", "vpc", "subnet"].includes(n.type)));
});

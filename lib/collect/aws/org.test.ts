import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode } from "@/lib/graph/types";
import { type OrgAccount, type OrgTree, scopeFromTree, standaloneScope } from "./org";
import { inferEnvironment } from "./util";

const ou = (id: string, name: string, parentId: string): GraphNode => ({ id, type: "ou", name, parentId, status: "ok", tags: {}, meta: {} });
const account = (id: string, name: string, parentId: string, extra: Partial<OrgAccount> = {}): OrgAccount => ({
  id,
  name,
  arn: `arn:aws:organizations::111111111111:account/o-x/${id}`,
  state: "ACTIVE",
  parentId,
  tags: {},
  ...extra,
});

const tree: OrgTree = {
  root: { id: "org", type: "organization", name: "o-x", status: "ok", tags: {}, meta: { orgId: "o-x" } },
  ous: [ou("ou-work", "Workloads", "org"), ou("ou-prod", "Prod", "ou-work"), ou("ou-sbx", "Sandbox", "org"), ou("ou-empty", "Empty", "org")],
  accounts: [
    account("111111111111", "management", "org"),
    account("222222222222", "payments", "ou-prod", { tags: { Environment: "Production" } }),
    account("333333333333", "sbx-1", "ou-sbx"),
    account("444444444444", "legacy", "ou-work", { state: "SUSPENDED" }),
  ],
};

test("organization scope keeps OUs on account paths and only targets active accounts", () => {
  const scope = scopeFromTree(tree, () => true, "org");
  const ids = scope.nodes.map((n) => n.id);
  assert.ok(ids.includes("ou-prod") && ids.includes("ou-work") && ids.includes("ou-sbx"));
  assert.ok(!ids.includes("ou-empty"), "OUs without selected accounts are dropped");
  assert.deepEqual(scope.targets.map((t) => t.accountId), ["111111111111", "222222222222", "333333333333"]);

  const legacy = scope.nodes.find((n) => n.accountId === "444444444444")!;
  assert.equal(legacy.status, "stopped");
  assert.equal(legacy.meta.accountStatus, "SUSPENDED");
});

test("account environment comes from tags, then name, then OU path; originals are preserved", () => {
  const scope = scopeFromTree(tree, () => true, "org");
  const env = (id: string) => scope.nodes.find((n) => n.accountId === id)!;
  assert.equal(env("222222222222").tags.Environment, "prod");
  assert.equal(env("222222222222").meta.environmentTag, "Production");
  assert.equal(env("333333333333").tags.Environment, "sandbox");
  assert.equal(env("111111111111").tags.Environment, "shared");
});

test("account selection prunes the tree to the selected accounts", () => {
  const scope = scopeFromTree(tree, (id) => id === "222222222222", "one");
  assert.deepEqual(scope.nodes.map((n) => n.id), ["org", "ou-work", "ou-prod", tree.accounts[1].arn]);
});

test("standalone scope puts accounts under a single synthetic root", () => {
  const scope = standaloneScope(["555555555555"]);
  assert.equal(scope.nodes.filter((n) => !n.parentId).length, 1);
  assert.equal(scope.nodes[1].parentId, "standalone");
  assert.equal(scope.targets[0].nodeId, "account/555555555555");
});

test("inferEnvironment", () => {
  const cases: [Record<string, string>, string, string[], string][] = [
    [{ env: "PRD" }, "x", [], "prod"],
    [{ Stage: "uat" }, "x", [], "staging"],
    [{}, "payments-prod", [], "prod"],
    [{}, "payments-nonprod", [], "dev"],
    [{}, "payments-preprod", [], "staging"],
    [{}, "product-catalog", ["Workloads"], "shared"],
    [{}, "catalog", ["Workloads", "Prod"], "prod"],
    [{}, "team-x", ["Sandbox"], "sandbox"],
    [{}, "log-archive", ["Security"], "shared"],
  ];
  for (const [tags, name, path, expected] of cases) assert.equal(inferEnvironment(tags, name, path), expected, `${name} ${JSON.stringify(tags)}`);
});

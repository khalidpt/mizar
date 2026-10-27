import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode, NodeType } from "@/lib/graph/types";
import { GraphBuilder } from "./builder";

const node = (id: string, type: NodeType, parentId?: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  name: id,
  parentId,
  status: "ok",
  tags: {},
  meta: {},
  ...extra,
});

/** org → two accounts, each with one region. */
function base() {
  const b = new GraphBuilder();
  b.add(node("org", "organization"));
  for (const a of ["a1", "a2"]) {
    b.add(node(a, "account", "org"));
    b.add(node(`region/${a}/r`, "region", a));
  }
  return b;
}

test("resolves parents and edges across accounts by alias, regardless of discovery order", () => {
  const b = base();
  // Account 2's subnet routes to account 1's transit gateway, which is discovered later.
  b.add(node("vpc2", "vpc", "region/a2/r"), { refs: ["ec2:vpc-2"] });
  b.add(node("sub2", "subnet", "region/a2/r"), { refs: ["ec2:subnet-2"], parentRef: "ec2:vpc-2" });
  b.add(node("i2", "ec2", "region/a2/r"), { parentRef: "ec2:subnet-2" });
  b.link("routes", "ec2:subnet-2", "ec2:tgw-1");
  b.link("tgw-attachment", "ec2:vpc-2", "ec2:tgw-1", "tgw-attach-1");
  b.add(node("tgw1", "tgw", "region/a1/r"), { refs: ["ec2:tgw-1"] });

  const { nodes, edges } = b.build();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("sub2")?.parentId, "vpc2");
  assert.equal(byId.get("i2")?.parentId, "sub2");
  assert.deepEqual(
    edges.map((e) => [e.kind, e.from, e.to]),
    [
      ["routes", "sub2", "tgw1"],
      ["tgw-attachment", "vpc2", "tgw1"],
    ],
  );
});

test("vpc-of: places a resource in the VPC of a subnet", () => {
  const b = base();
  b.add(node("vpc", "vpc", "region/a1/r"), { refs: ["ec2:vpc-1"] });
  b.add(node("sub", "subnet", "region/a1/r"), { refs: ["ec2:subnet-1"], parentRef: "ec2:vpc-1" });
  b.add(node("svc", "ecs-service", "region/a1/r"), { parentRef: "vpc-of:ec2:subnet-1" });
  assert.equal(b.build().nodes.find((n) => n.id === "svc")?.parentId, "vpc");
});

test("vpc-of: works whatever order the resource and its subnet are discovered in", () => {
  const b = base();
  b.add(node("cache", "elasticache", "region/a1/r"), { parentRef: "vpc-of:ec2:subnet-1" });
  b.add(node("vpc", "vpc", "region/a1/r"), { refs: ["ec2:vpc-1"] });
  b.add(node("sub", "subnet", "region/a1/r"), { refs: ["ec2:subnet-1"], parentRef: "ec2:vpc-1" });
  assert.equal(b.build().nodes.find((n) => n.id === "cache")?.parentId, "vpc");
});

test("unresolvable parents fall back; unresolvable and duplicate edges are dropped", () => {
  const b = base();
  b.add(node("fn", "lambda", "region/a1/r"), { parentRef: "ec2:subnet-in-another-org" });
  b.add(node("q", "sqs", "region/a1/r"));
  b.link("invokes", "q", "fn");
  b.link("invokes", "q", "fn");
  b.link("invokes", "arn:outside-scope", "fn");
  // Both sides of a peering connection report it once each.
  b.add(node("v1", "vpc", "region/a1/r"), { refs: ["ec2:vpc-1"] });
  b.add(node("v2", "vpc", "region/a2/r"), { refs: ["ec2:vpc-2"] });
  b.link("peering", "ec2:vpc-1", "ec2:vpc-2", "pcx-1");
  b.link("peering", "ec2:vpc-1", "ec2:vpc-2", "pcx-1");

  const { nodes, edges, dropped } = b.build({ includeEmptyDefaultVpcs: true });
  assert.equal(nodes.find((n) => n.id === "fn")?.parentId, "region/a1/r");
  assert.equal(edges.filter((e) => e.kind === "invokes").length, 1);
  assert.equal(edges.filter((e) => e.kind === "peering").length, 1);
  assert.equal(dropped, 1);
});

test("first write wins for a node reported twice", () => {
  const b = base();
  b.add(node("bucket", "s3", "region/a1/r", { name: "first" }));
  b.add(node("bucket", "s3", "region/a2/r", { name: "second" }));
  assert.equal(b.build().nodes.filter((n) => n.id === "bucket").map((n) => n.name).join(), "first");
});

test("infers subnet tiers: Tier tag, then internet route, then data-ish name, else private", () => {
  const b = base();
  b.add(node("vpc", "vpc", "region/a1/r"), { refs: ["ec2:vpc-1"] });
  b.add(node("igw", "igw", "vpc"), { refs: ["ec2:igw-1"] });
  b.add(node("tagged", "subnet", "vpc", { tags: { tier: "Data" } }));
  b.add(node("public-ish", "subnet", "vpc"), { refs: ["ec2:subnet-pub"] });
  b.add(node("app-db-a", "subnet", "vpc"));
  b.add(node("app-a", "subnet", "vpc"));
  b.add(node("database-x", "subnet", "vpc"));
  b.link("routes", "ec2:subnet-pub", "ec2:igw-1");

  const tiers = Object.fromEntries(b.build().nodes.filter((n) => n.type === "subnet").map((n) => [n.id, n.meta.tier]));
  assert.deepEqual(tiers, { tagged: "data", "public-ish": "public", "app-db-a": "data", "app-a": "private", "database-x": "data" });
});

test("hides unused default VPCs and regions left empty, keeps used ones", () => {
  const b = base();
  b.add(node("default-empty", "vpc", "region/a1/r", { meta: { isDefault: true } }));
  b.add(node("default-empty-subnet", "subnet", "default-empty"));
  b.add(node("default-empty-igw", "igw", "default-empty"));
  b.add(node("default-used", "vpc", "region/a2/r", { meta: { isDefault: true } }));
  b.add(node("default-used-subnet", "subnet", "default-used"));
  b.add(node("instance", "ec2", "default-used-subnet"));
  b.link("routes", "default-empty-subnet", "default-empty-igw");

  const { nodes, edges } = b.build();
  const ids = new Set(nodes.map((n) => n.id));
  assert.ok(!ids.has("default-empty") && !ids.has("default-empty-subnet") && !ids.has("default-empty-igw"));
  assert.ok(!ids.has("region/a1/r"), "region with nothing left is removed");
  assert.ok(ids.has("default-used") && ids.has("instance") && ids.has("region/a2/r"));
  assert.equal(edges.length, 0);

  const kept = base();
  kept.add(node("default-empty", "vpc", "region/a1/r", { meta: { isDefault: true } }));
  assert.ok(kept.build({ includeEmptyDefaultVpcs: true }).nodes.some((n) => n.id === "default-empty"));
});

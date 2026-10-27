import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The IAM actions live in three places users copy from: the member-role (or cost-role) template, the collector-role
 * template and the README. Keep them identical, and make sure every AWS API the collector calls is allowed somewhere.
 */

const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** `- service:Action` list items of a policy section of a template. */
function templateActions(path: string, policyName: string): string[] {
  const text = read(path);
  const start = text.indexOf(`PolicyName: ${policyName}`);
  assert.ok(start >= 0, `${path} has no ${policyName} policy`);
  const end = text.indexOf("PolicyName:", start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\s*- ([a-z0-9-]+:[A-Za-z]+)\s*$/gm)].map((m) => m[1]);
}

const member = templateActions("deploy/cloudformation/mizar-member-role.yaml", "MizarInventory");
const cost = templateActions("deploy/cloudformation/mizar-cost-role.yaml", "MizarCost");
const collector = "deploy/cloudformation/mizar-collector-role.yaml";

/** Actions of the README's JSON policy blocks, the first one containing `marker`. */
function readmeActions(marker: string): string[] {
  const blocks = [...read("README.md").matchAll(/```json\n(\{[\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes('"Action"') && b.includes(marker));
  assert.ok(block, `README has no policy block with ${marker}`);
  return (JSON.parse(block).Statement as { Action: string[] }[]).flatMap((s) => s.Action);
}

test("member role, collector role and README list the same inventory actions", () => {
  assert.deepEqual(member, readmeActions('"ec2:'));
  assert.deepEqual(templateActions(collector, "MizarInventory"), member);
  assert.equal(new Set(member).size, member.length, "duplicate actions");
});

test("cost role, collector role and README list the same cost actions", () => {
  assert.deepEqual(cost, readmeActions('"ce:'));
  assert.deepEqual(templateActions(collector, "MizarCost"), cost);
});

test("every AWS API the collector calls is allowed", () => {
  const allowed = new Set(
    [...member, ...cost, ...templateActions(collector, "MizarOrganization")].map((action) => action.split(":")[1]),
  );
  // SDK command or paginator name → IAM action name, where they differ.
  const alias: Record<string, string | null> = {
    GetCallerIdentity: null, // needs no permission
    ListBuckets: "ListAllMyBuckets",
    ListEcsClusters: "ListClusters",
    ListEksClusters: "ListClusters",
    // API Gateway has one read action, `apigateway:GET`, scoped by resource path.
    GetRestApis: "GET",
    GetResources: "GET",
    GetVpcLinks: "GET",
    GetApis: "GET",
    GetIntegrations: "GET",
  };

  const dir = join(root, "lib/collect/aws");
  const called = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    for (const [, name] of readFileSync(join(dir, file), "utf8").matchAll(/\b(?:paginate([A-Z]\w+)|([A-Z]\w+)Command)\b/g).map((m) => [m[0], m[1] ?? m[2]])) {
      called.add(name);
    }
  }
  assert.ok(called.size > 20, "found the collector's API calls");

  const missing = [...called].filter((name) => {
    const action = name in alias ? alias[name] : name;
    return action !== null && !allowed.has(action);
  });
  assert.deepEqual(missing, [], "add these to the templates and the README (or to the alias map above)");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config";

test("inline MIZAR_CONFIG_JSON replaces the file; variables still win", () => {
  const config = loadConfig({
    MIZAR_CONFIG_JSON: JSON.stringify({ source: "aws", retain: 5, aws: { scope: "current", regions: ["eu-west-1"] } }),
    MIZAR_RETAIN: "7",
  });
  assert.equal(config.source, "aws");
  assert.equal(config.retain, 7);
  assert.equal(config.aws.scope, "current");
  assert.deepEqual(config.aws.regions, ["eu-west-1"]);

  assert.throws(() => loadConfig({ MIZAR_CONFIG_JSON: "{nope" }), /Could not parse MIZAR_CONFIG_JSON/);
  assert.throws(() => loadConfig({ MIZAR_CONFIG_JSON: "{}", MIZAR_CONFIG: "x.json" }), /not both/);
});

test("cost settings merge from the file and variables", () => {
  const config = loadConfig({
    MIZAR_CONFIG_JSON: JSON.stringify({ aws: { cost: { enabled: true, metric: "AmortizedCost" } } }),
    MIZAR_AWS_COST_ACCOUNT_ID: "123456789012",
  });
  assert.deepEqual(config.aws.cost, {
    enabled: true,
    accountId: "123456789012",
    roleName: "MizarCostReader",
    rolePath: "/",
    metric: "AmortizedCost",
  });
  assert.equal(loadConfig({ MIZAR_CONFIG_JSON: "{}" }).aws.cost.enabled, false);
  assert.equal(loadConfig({ MIZAR_CONFIG_JSON: JSON.stringify({ aws: { cost: { enabled: true } } }), MIZAR_AWS_COST: "false" }).aws.cost.enabled, false);
  assert.throws(() => loadConfig({ MIZAR_CONFIG_JSON: "{}", MIZAR_AWS_COST_METRIC: "Cheapest" }), /Invalid Mizar configuration/);
});

test("ui.costs defaults on and can be turned off", () => {
  assert.equal(loadConfig({ MIZAR_CONFIG_JSON: "{}" }).ui.costs, true);
  assert.equal(loadConfig({ MIZAR_CONFIG_JSON: JSON.stringify({ ui: { costs: false } }) }).ui.costs, false);
  assert.equal(loadConfig({ MIZAR_CONFIG_JSON: "{}", MIZAR_UI_COSTS: "false" }).ui.costs, false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { generateMockGraph } from "./mock";
import { checkSnapshot, infraGraphJsonSchema } from "./schema";
import type { InfraGraph } from "./types";

const published = JSON.parse(readFileSync(new URL("../../schema/infra-graph.v1.schema.json", import.meta.url), "utf8"));

/** The published file, checked by an independent validator: what third-party collectors and readers will use. */
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validatePublished = ajv.compile(published);

const graph = generateMockGraph({ generatedAt: "2026-10-20T08:00:00.000Z" });
const variant = (change: (g: InfraGraph) => void): unknown => {
  const copy = structuredClone(graph);
  change(copy);
  return copy;
};

test("the published schema file is up to date (npm run schema)", () => {
  assert.deepEqual(published, infraGraphJsonSchema());
});

describe("valid snapshots", () => {
  for (const [name, g] of [
    ["default mock organization", graph],
    ["large mock organization", generateMockGraph({ teams: 60 })],
  ] as const) {
    test(name, () => {
      assert.deepEqual(checkSnapshot(g), []);
      assert.ok(validatePublished(g), JSON.stringify(validatePublished.errors?.slice(0, 3)));
    });
  }
});

describe("invalid snapshots", () => {
  const cases: [string, unknown, RegExp][] = [
    ["another version", variant((g) => ((g as { version: number }).version = 2)), /^version:/],
    ["an unknown node type", variant((g) => ((g.nodes[1] as { type: string }).type = "sns")), /^nodes\.1\.type:/],
    ["an unknown field", variant((g) => Object.assign(g.nodes[1], { owner: "me" })), /^nodes\.1:.*owner/],
    ["a malformed account id", variant((g) => (g.nodes.find((n) => n.accountId)!.accountId = "1234")), /accountId:/],
    ["a nested meta value", variant((g) => ((g.nodes[1].meta as Record<string, unknown>).cidr = { v: 1 })), /meta\.cidr:/],
    ["a non-UTC timestamp", variant((g) => (g.generatedAt = "2026-10-20 08:00")), /^generatedAt:/],
    ["an unknown edge kind", variant((g) => ((g.edges[0] as { kind: string }).kind = "uses")), /^edges\.0\.kind:/],
  ];
  for (const [name, value, message] of cases) {
    test(`rejects ${name}`, () => {
      const errors = checkSnapshot(value);
      assert.ok(errors.some((e) => message.test(e)), errors.join("\n"));
      assert.equal(validatePublished(value), false, "the published schema accepts it");
    });
  }

  test("rejects what only the graph rules catch", () => {
    const orphan = variant((g) => (g.nodes[1].parentId = "missing"));
    assert.deepEqual(checkSnapshot(orphan), [`node ${graph.nodes[1].id} has missing parent missing`]);
    assert.ok(validatePublished(orphan), "structurally valid");
  });
});

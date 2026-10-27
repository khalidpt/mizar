import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWarnings } from "./index";

test("groupWarnings collapses one error across regions into one line", () => {
  const denied = (region: string) => ({ service: "cloudwatch", region, message: `AccessDenied: no cloudwatch:DescribeAlarms in ${region}` });
  assert.deepEqual(groupWarnings([denied("us-east-1"), denied("eu-west-1"), { service: "eks", region: "us-east-1", message: "Throttling: slow down" }]), [
    "cloudwatch in 2 regions: AccessDenied: no cloudwatch:DescribeAlarms in us-east-1",
    "eks in us-east-1: Throttling: slow down",
  ]);
});

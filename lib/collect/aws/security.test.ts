import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode } from "@/lib/graph/types";
import { markAlarm } from "./alarms";
import { describePermission, sensitiveExposure } from "./security";

test("describePermission", () => {
  assert.equal(describePermission({ IpProtocol: "-1" }), "all traffic");
  assert.equal(describePermission({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 }), "tcp/443");
  assert.equal(describePermission({ IpProtocol: "6", FromPort: 1024, ToPort: 2048 }), "tcp/1024-2048");
  assert.equal(describePermission({ IpProtocol: "udp", FromPort: 0, ToPort: 65535 }), "udp/all ports");
  assert.equal(describePermission({ IpProtocol: "icmp", FromPort: -1, ToPort: -1 }), "icmp");
});

test("sensitiveExposure names admin and database ports, summarizes wide ranges", () => {
  assert.deepEqual(sensitiveExposure({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 }), []);
  assert.deepEqual(sensitiveExposure({ IpProtocol: "tcp", FromPort: 3389, ToPort: 3389 }), ["RDP (tcp/3389)"]);
  assert.deepEqual(sensitiveExposure({ IpProtocol: "-1" }), ["all traffic"]);
  assert.deepEqual(sensitiveExposure({ IpProtocol: "tcp", FromPort: 0, ToPort: 65535 }), ["tcp/all ports (incl. FTP, SSH, Telnet)"]);
  assert.deepEqual(sensitiveExposure({ IpProtocol: "icmp" }), []);
});

test("markAlarm lists three names, then a count", () => {
  const node: GraphNode = { id: "x", type: "ec2", name: "x", status: "ok", tags: {}, meta: {} };
  for (const name of ["a", "b", "c", "d", "e"]) markAlarm(node, name);
  assert.equal(node.meta.alarms, "a; b; c; … +2");
  assert.equal(node.meta.alarmsCount, 5);
  assert.equal(node.status, "critical");
});

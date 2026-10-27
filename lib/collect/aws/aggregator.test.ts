import assert from "node:assert/strict";
import { test } from "node:test";
import { indexGraph, validateGraph } from "@/lib/graph/query";
import { type ConfigItem, type ConfigType, enrichmentNeeds, groupItems, lowerKeys, mapConfigDeferred, mapConfigRegion, upperKeys } from "./aggregator";
import { GraphBuilder } from "./builder";
import type { AccountContext } from "./map";
import { SecurityGroups } from "./security";

const R = "us-east-1";
const A = "111111111111";
const at = (service: string, resource: string) => `arn:aws:${service}:${R}:${A}:${resource}`;
const name = (Name: string) => [{ key: "Name", value: Name }];

/** Config items as the aggregator returns them: service-API shapes in camelCase, CloudFormation shapes in PascalCase. */
function item(resourceType: ConfigType, resourceId: string, configuration: unknown, extra: Partial<ConfigItem> = {}): ConfigItem {
  return { accountId: A, awsRegion: R, resourceType, resourceId, configuration, configurationItemStatus: "OK", ...extra };
}

const lbArn = at("elasticloadbalancing", "loadbalancer/app/web/abc");
const tgArn = at("elasticloadbalancing", "targetgroup/api/1");
const items: ConfigItem[] = [
  item("AWS::EC2::VPC", "vpc-1", { vpcId: "vpc-1", ownerId: A, cidrBlock: "10.0.0.0/16", isDefault: false, state: { value: "available" }, tags: name("app") }),
  item("AWS::EC2::VPC", "vpc-2", { vpcId: "vpc-2", ownerId: A, cidrBlock: "10.1.0.0/16", isDefault: false, state: { value: "available" }, tags: name("peer") }),
  item("AWS::EC2::Subnet", "subnet-1", {
    subnetId: "subnet-1",
    vpcId: "vpc-1",
    ownerId: A,
    availabilityZone: "us-east-1a",
    cidrBlock: "10.0.1.0/24",
    mapPublicIpOnLaunch: false,
    state: { value: "available" },
    tags: name("app-private-a"),
  }),
  item("AWS::EC2::SecurityGroup", "sg-app", {
    groupId: "sg-app",
    groupName: "app",
    // Config records both `ipRanges` (strings) and `ipv4Ranges` (objects); numbers come back as floats.
    ipPermissions: [{ ipProtocol: "tcp", fromPort: 22.0, toPort: 22.0, ipRanges: ["0.0.0.0/0"], ipv4Ranges: [{ cidrIp: "0.0.0.0/0" }], ipv6Ranges: [], userIdGroupPairs: [] }],
  }),
  item("AWS::EC2::SecurityGroup", "sg-db", {
    groupId: "sg-db",
    groupName: "db",
    ipPermissions: [{ ipProtocol: "tcp", fromPort: 5432.0, toPort: 5432.0, ipRanges: [], ipv4Ranges: [], ipv6Ranges: [], userIdGroupPairs: [{ groupId: "sg-app" }] }],
  }),
  item("AWS::EC2::SecurityGroup", "sg-lb", {
    groupId: "sg-lb",
    groupName: "lb",
    ipPermissions: [{ ipProtocol: "tcp", fromPort: 443.0, toPort: 443.0, ipRanges: ["0.0.0.0/0"], ipv4Ranges: [{ cidrIp: "0.0.0.0/0" }], userIdGroupPairs: [] }],
  }),
  item("AWS::EC2::NatGateway", "nat-1", { natGatewayId: "nat-1", subnetId: "subnet-1", vpcId: "vpc-1", state: { value: "available" } }),
  item("AWS::EC2::TransitGateway", "tgw-1", { Id: "tgw-1", AmazonSideAsn: 64512.0 }, { arn: at("ec2", "transit-gateway/tgw-1"), tags: [{ key: "Name", value: "hub" }] }),
  item("AWS::EC2::TransitGatewayAttachment", "tgw-attach-1", { Id: "tgw-attach-1", TransitGatewayId: "tgw-1", VpcId: "vpc-1" }),
  item("AWS::EC2::VPNGateway", "vgw-1", {
    vpnGatewayId: "vgw-1",
    state: "available",
    type: "ipsec.1",
    amazonSideAsn: 64512.0,
    vpcAttachments: [{ state: "attached", vpcId: "vpc-1" }],
  }),
  item("AWS::EC2::CustomerGateway", "cgw-1", { customerGatewayId: "cgw-1", bgpAsn: "65010", ipAddress: "198.51.100.7", state: "available" }, { tags: name("office") }),
  // Config's copy of tunnel telemetry may be stale (all down here): ignored. Pre-shared keys: never read.
  item("AWS::EC2::VPNConnection", "vpn-1", {
    vpnConnectionId: "vpn-1",
    customerGatewayId: "cgw-1",
    vpnGatewayId: "vgw-1",
    state: "available",
    options: { staticRoutesOnly: true, tunnelOptions: [{ preSharedKey: "psk-secret-1" }] },
    routes: [{ destinationCidrBlock: "192.168.10.0/24", source: "Static", state: "available" }],
    customerGatewayConfiguration: "<vpn_connection><pre_shared_key>psk-secret-2</pre_shared_key></vpn_connection>",
    vgwTelemetry: [{ status: "DOWN" }, { status: "DOWN" }],
  }),
  item("AWS::EC2::RouteTable", "rtb-1", {
    routeTableId: "rtb-1",
    vpcId: "vpc-1",
    ownerId: A,
    associations: [{ main: true }],
    routes: [
      { gatewayId: "local", state: "active" },
      { natGatewayId: "nat-1", state: "active" },
      { transitGatewayId: "tgw-1", state: "active" },
      { gatewayId: "vpce-fw-1", destinationCidrBlock: "10.9.0.0/16", state: "active" },
    ],
  }),
  item("AWS::EC2::VPCPeeringConnection", "pcx-1", {
    vpcPeeringConnectionId: "pcx-1",
    status: { code: "active" },
    requesterVpcInfo: { vpcId: "vpc-1" },
    accepterVpcInfo: { vpcId: "vpc-2" },
  }),
  item("AWS::EC2::Instance", "i-1", {
    instanceId: "i-1",
    subnetId: "subnet-1",
    instanceType: "t3.small",
    state: { code: 16.0, name: "running" },
    publicIpAddress: "203.0.113.10",
    placement: { availabilityZone: "us-east-1a" },
    securityGroups: [{ groupId: "sg-app", groupName: "app" }],
    tags: name("app-1"),
  }),
  item("AWS::EC2::Instance", "i-gone", { instanceId: "i-gone", subnetId: "subnet-1", state: { code: 48.0, name: "terminated" } }),
  item("AWS::ElasticLoadBalancingV2::LoadBalancer", lbArn, {
    loadBalancerArn: lbArn,
    loadBalancerName: "web",
    type: "application",
    scheme: "internet-facing",
    vpcId: "vpc-1",
    dNSName: "web.example.com",
    state: { code: "active" },
    securityGroups: [{ value: "sg-lb" }],
  }),
  item("AWS::ECS::Service", "api", {
    ServiceArn: at("ecs", "service/main/api"),
    ServiceName: "api",
    Cluster: at("ecs", "cluster/main"),
    LaunchType: "FARGATE",
    DesiredCount: 2.0,
    NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ["subnet-1"], SecurityGroups: ["sg-app"], AssignPublicIp: "DISABLED" } },
    LoadBalancers: [{ TargetGroupArn: tgArn, ContainerPort: 8080.0 }],
  }),
  item("AWS::EKS::Cluster", "platform", {
    Arn: at("eks", "cluster/platform"),
    Name: "platform",
    Version: "1.34",
    ResourcesVpcConfig: { SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-app"] },
  }),
  item("AWS::Lambda::Function", "worker", {
    functionArn: at("lambda", "function:worker"),
    functionName: "worker",
    runtime: "nodejs22.x",
    memorySize: 512.0,
    state: { value: "Active" },
    vpcConfig: { subnetIds: ["subnet-1"], securityGroupIds: ["sg-app"] },
  }),
  item(
    "AWS::RDS::DBInstance",
    "orders",
    {
      dBInstanceArn: at("rds", "db:orders"),
      dBInstanceIdentifier: "orders",
      engine: "postgres",
      dBInstanceClass: "db.t4g.medium",
      dBInstanceStatus: "available",
      availabilityZone: "us-east-1a",
      multiAZ: false,
      publiclyAccessible: false,
      dBSubnetGroup: { subnets: [{ subnetIdentifier: "subnet-1", subnetAvailabilityZone: { name: "us-east-1a" } }] },
      vpcSecurityGroups: [{ vpcSecurityGroupId: "sg-db", status: "active" }],
    },
    { tags: [{ key: "team", value: "payments" }] },
  ),
  item("AWS::DynamoDB::Table", "state", {
    tableArn: at("dynamodb", "table/state"),
    tableName: "state",
    tableStatus: "ACTIVE",
    billingModeSummary: { billingMode: "PAY_PER_REQUEST" },
    itemCount: 10.0,
  }),
  item("AWS::SQS::Queue", "orders", { QueueName: "orders", QueueArn: at("sqs", "orders") }),
  item("AWS::S3::Bucket", "assets", { name: "assets", region: R }),
  item("AWS::CloudWatch::Alarm", "cpu", { alarmName: "cpu", namespace: "AWS/EC2" }),
  item("AWS::ApiGateway::RestApi", "abc123", { id: "abc123", name: "orders-api", endpointConfiguration: { types: ["REGIONAL"] } }, { tags: [{ key: "team", value: "payments" }] }),
  item("AWS::ApiGatewayV2::Api", "h1", { apiId: "h1", name: "public-api", protocolType: "HTTP", apiEndpoint: "https://h1.execute-api.us-east-1.amazonaws.com" }),
  // A global resource: kept although only us-east-1 is in scope, and placed in us-east-1.
  item(
    "AWS::CloudFront::Distribution",
    "E123",
    {
      id: "E123",
      arn: `arn:aws:cloudfront::${A}:distribution/E123`,
      domainName: "d111.cloudfront.net",
      distributionConfig: {
        enabled: true,
        priceClass: "PriceClass_100",
        aliases: { quantity: 1, items: ["www.example.com"] },
        origins: {
          quantity: 2,
          items: [
            { id: "assets", domainName: "assets.s3.us-east-1.amazonaws.com" },
            { id: "api", domainName: "abc123.execute-api.us-east-1.amazonaws.com" },
          ],
        },
      },
    },
    { awsRegion: "global" },
  ),
  item("AWS::NetworkFirewall::Firewall", "fw-1", {
    FirewallName: "inspection",
    FirewallArn: at("network-firewall", "firewall/inspection"),
    FirewallPolicyArn: at("network-firewall", "firewall-policy/strict"),
    VpcId: "vpc-1",
    SubnetMappings: [{ SubnetId: "subnet-1" }],
    EndpointIds: ["us-east-1a:vpce-fw-1"],
  }),
  item("AWS::WorkSpaces::Workspace", "ws-1", { Id: "ws-1", DirectoryId: "d-1", UserName: "alice", BundleId: "wsb-1", WorkspaceProperties: { RunningMode: "AUTO_STOP" } }),
  item("AWS::WorkSpaces::Workspace", "ws-2", { Id: "ws-2", DirectoryId: "d-1", UserName: "bob", BundleId: "wsb-1", WorkspaceProperties: { RunningMode: "AUTO_STOP" } }),
  // Outside the collection scope (account, region): ignored.
  item("AWS::S3::Bucket", "other-account", { name: "other-account", region: R }, { accountId: "999999999999" }),
  item("AWS::S3::Bucket", "other-region", { name: "other-region", region: "eu-west-1" }, { awsRegion: "eu-west-1" }),
];

function build() {
  const b = new GraphBuilder();
  const security = new SecurityGroups();
  b.add({ id: "org", type: "organization", name: "org", status: "ok", tags: {}, meta: {} });
  b.add({ id: "acct", type: "account", name: A, parentId: "org", accountId: A, status: "ok", tags: {}, meta: {} });
  const ctx: AccountContext = { b, accountId: A, nodeId: "acct", partition: "aws", security, attempt: (_s, _r, fn) => fn() };

  const grouped = groupItems(items, new Set([A]), new Set([R]));
  const regions = [...(grouped.get(A)?.values() ?? [])];
  for (const region of regions) {
    mapConfigRegion(ctx, region);
    mapConfigDeferred(ctx, region, new Map([[tgArn, [lbArn]]]));
  }
  security.apply(b);
  const { nodes, edges } = b.build();
  return { graph: { version: 1 as const, source: "aws" as const, generatedAt: "", nodes, edges }, regions };
}

test("key conversion between Config and SDK shapes", () => {
  assert.deepEqual(upperKeys({ dBInstanceArn: "x", dBSubnetGroup: { subnets: [{ subnetIdentifier: "s" }] } }), {
    DBInstanceArn: "x",
    DBSubnetGroup: { Subnets: [{ SubnetIdentifier: "s" }] },
  });
  assert.deepEqual(lowerKeys({ NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ["a"] } } }), {
    networkConfiguration: { awsvpcConfiguration: { subnets: ["a"] } },
  });
});

test("Config items map to the same graph shapes as the direct collector", () => {
  const { graph } = build();
  assert.deepEqual(validateGraph(graph), []);
  const index = indexGraph(graph);
  const get = (id: string) => index.byId.get(id)!;
  const parentName = (id: string) => index.byId.get(get(id).parentId!)!.name;
  const ec2 = (r: string) => at("ec2", r);

  assert.equal(parentName(ec2("subnet/subnet-1")), "app");
  assert.equal(get(ec2("subnet/subnet-1")).az, "us-east-1a");
  assert.equal(parentName(ec2("instance/i-1")), "app-private-a");
  assert.ok(!index.byId.has(ec2("instance/i-gone")), "terminated instances are skipped");
  assert.equal(parentName(ec2("natgateway/nat-1")), "app-private-a");
  assert.equal(get(ec2("transit-gateway/tgw-1")).name, "hub");
  assert.equal(parentName(ec2("vpn-gateway/vgw-1")), "app");
  const vpn = get(ec2("vpn-connection/vpn-1"));
  assert.equal(vpn.name, "office");
  assert.equal(vpn.status, "ok");
  assert.equal(vpn.meta.tunnels, undefined, "no telemetry from Config");
  assert.equal(vpn.meta.routing, "static");
  assert.equal(vpn.meta.staticRoutes, "192.168.10.0/24");
  assert.equal(vpn.meta.customerGatewayIp, "198.51.100.7");
  assert.ok(!JSON.stringify(graph).includes("psk-secret"));
  const fw = get(at("network-firewall", "firewall/inspection"));
  assert.equal(parentName(fw.id), "app");
  assert.deepEqual(fw.meta, { policy: "strict", endpoints: 1, zones: "us-east-1a" }, "no status from Config");
  // Without enrichment, WorkSpaces are counted per directory in their region (Config records no directories).
  const desktops = get(at("workspaces", "directoryid/d-1"));
  assert.equal(desktops.parentId, `region/${A}/${R}`);
  assert.deepEqual(desktops.meta, { directoryId: "d-1", workspaces: 2, runningModes: "AUTO_STOP 2" });
  assert.ok(!JSON.stringify(graph).includes("alice"));
  assert.equal(parentName(lbArn), "app");
  assert.equal(parentName(at("ecs", "service/main/api")), "app");
  assert.equal(parentName(at("eks", "cluster/platform")), "app", "EKS records have subnets but no VPC id");
  assert.equal(parentName(at("lambda", "function:worker")), "app-private-a");
  assert.equal(parentName(at("rds", "db:orders")), "app-private-a");
  assert.equal(get(at("rds", "db:orders")).tags.team, "payments");
  assert.equal(get(at("dynamodb", "table/state")).meta.billingMode, "PAY_PER_REQUEST");
  assert.equal(parentName(at("sqs", "orders")), R);
  assert.equal(parentName("arn:aws:s3:::assets"), R);
  assert.ok(!index.byId.has("arn:aws:s3:::other-account") && !index.byId.has("arn:aws:s3:::other-region"));
  assert.equal(parentName(`arn:aws:apigateway:${R}::/restapis/abc123`), R);
  assert.equal(get(`arn:aws:apigateway:${R}::/restapis/abc123`).tags.team, "payments");
  assert.equal(get(`arn:aws:apigateway:${R}::/apis/h1`).meta.protocol, "HTTP");
  const cdn = get(`arn:aws:cloudfront::${A}:distribution/E123`);
  assert.equal(cdn.name, "www.example.com");
  assert.equal(cdn.parentId, `region/${A}/us-east-1`);

  // Config records no task counts: an ECS service is "ok" rather than guessed unhealthy.
  assert.equal(get(at("ecs", "service/main/api")).status, "ok");
  assert.equal(get(at("ecs", "service/main/api")).meta.cluster, "main");

  const edges = new Set(graph.edges.map((e) => `${e.kind} ${get(e.from).name} → ${get(e.to).name}`));
  for (const expected of [
    "routes app-private-a → nat-1",
    "routes app-private-a → hub",
    "tgw-attachment app → hub",
    "vpn office → vgw-1",
    "routes app-private-a → inspection",
    "peering app → peer",
    "targets web → api",
    "connects app-1 → orders",
    "connects api → orders",
    "connects platform → orders",
    "connects worker → orders",
    "targets www.example.com → assets",
    "targets www.example.com → orders-api",
  ]) {
    assert.ok(edges.has(expected), `missing edge: ${expected}\n  have: ${[...edges].join("\n        ")}`);
  }

  // Security group findings work from Config's rule shape.
  assert.equal(get(ec2("instance/i-1")).meta.exposure, "SSH (tcp/22) open to the internet");
  assert.equal(get(lbArn).meta.securityGroups, "lb");
  assert.equal(get(lbArn).meta.internetIngress, "tcp/443");
});

test("enrichment is only planned where Config found something it can't describe fully", () => {
  const { regions } = build();
  assert.deepEqual(enrichmentNeeds(regions[0]), {
    targets: true,
    ecs: true,
    eventSources: true,
    alarms: true,
    apis: true,
    vpn: true,
    firewalls: true,
    workspaces: true,
    caches: true,
  });
  const none = { targets: false, ecs: false, eventSources: false, alarms: false, apis: false, vpn: false, firewalls: false, workspaces: false, caches: false };
  // CloudFront's "global" region needs nothing.
  assert.deepEqual(enrichmentNeeds(regions.find((r) => r.region === "global")!), none);
  // ElastiCache (not in Config) is only looked for where there is a VPC of one's own, not just the default ones.
  const network = items.filter((i) => i.resourceType.startsWith("AWS::EC2::"));
  const onlyNetwork = groupItems(network, new Set([A]), undefined);
  assert.deepEqual(enrichmentNeeds([...onlyNetwork.get(A)!.values()][0]), { ...none, caches: true, vpn: true });
  const defaults = network.map((i) => (i.resourceType === "AWS::EC2::VPC" ? { ...i, configuration: { ...i.configuration, isDefault: true } } : i));
  assert.deepEqual(enrichmentNeeds([...groupItems(defaults, new Set([A]), undefined).get(A)!.values()][0]), { ...none, vpn: true });
});

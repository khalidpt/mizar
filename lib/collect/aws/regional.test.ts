import assert from "node:assert/strict";
import { test } from "node:test";
import { indexGraph, validateGraph } from "@/lib/graph/query";
import type { InfraGraph } from "@/lib/graph/types";
import { GraphBuilder } from "./builder";
import { mapBuckets } from "./map";
import { type AccountContext, collectBuckets, collectDistributions, collectRegion } from "./regional";
import { SecurityGroups } from "./security";
import { cloudFrontClient, destroyClients, regionClients, s3Client } from "./session";

const REGION = "us-east-1";
const A = "111111111111";
const B = "222222222222";

type Responses = Record<string, unknown | ((input: Record<string, unknown>) => unknown)>;

/**
 * Real SDK clients (paginators check `instanceof`) whose `send` answers from fixtures keyed by command name, or by
 * `<client>.<command>` where two services share a command name (ECS and EKS `ListClusters`).
 */
function fakeClients(responses: Responses) {
  const clients = regionClients(REGION, async () => ({ accessKeyId: "test", secretAccessKey: "test" }));
  for (const [key, client] of Object.entries(clients)) {
    (client as unknown as { send: (cmd: { input: Record<string, unknown> }) => Promise<unknown> }).send = async (cmd) => {
      const name = cmd.constructor.name;
      const response = responses[`${key}.${name}`] ?? responses[name];
      if (response === undefined) throw Object.assign(new Error(`not allowed: ${name}`), { name: "AccessDeniedException" });
      return typeof response === "function" ? response(cmd.input) : response;
    };
  }
  return clients;
}

const empty: Responses = {
  DescribeVpcsCommand: { Vpcs: [] },
  DescribeSubnetsCommand: { Subnets: [] },
  DescribeSecurityGroupsCommand: { SecurityGroups: [] },
  DescribeAlarmsCommand: { MetricAlarms: [] },
  DescribeInternetGatewaysCommand: { InternetGateways: [] },
  DescribeNatGatewaysCommand: { NatGateways: [] },
  DescribeTransitGatewaysCommand: { TransitGateways: [] },
  DescribeInstancesCommand: { Reservations: [] },
  DescribeRouteTablesCommand: { RouteTables: [] },
  DescribeVpcPeeringConnectionsCommand: { VpcPeeringConnections: [] },
  DescribeTransitGatewayVpcAttachmentsCommand: { TransitGatewayVpcAttachments: [] },
  DescribeVpnGatewaysCommand: { VpnGateways: [] },
  DescribeVpnConnectionsCommand: { VpnConnections: [] },
  DescribeCustomerGatewaysCommand: { CustomerGateways: [] },
  DescribeLoadBalancersCommand: { LoadBalancers: [] },
  DescribeTargetGroupsCommand: { TargetGroups: [] },
  "ecs.ListClustersCommand": {},
  "eks.ListClustersCommand": { clusters: [] },
  ListFunctionsCommand: { Functions: [] },
  ListEventSourceMappingsCommand: { EventSourceMappings: [] },
  DescribeDBInstancesCommand: { DBInstances: [] },
  ListTablesCommand: { TableNames: [] },
  ListQueuesCommand: {},
  DescribeReplicationGroupsCommand: { ReplicationGroups: [] },
  DescribeCacheClustersCommand: { CacheClusters: [] },
  DescribeCacheSubnetGroupsCommand: { CacheSubnetGroups: [] },
  DescribeServerlessCachesCommand: { ServerlessCaches: [] },
  GetRestApisCommand: { items: [] },
  GetApisCommand: { Items: [] },
  ListFirewallsCommand: { Firewalls: [] },
  DescribeWorkspaceDirectoriesCommand: { Directories: [] },
  DescribeWorkspacesCommand: { Workspaces: [] },
};

const tag = (Name: string) => [{ Key: "Name", Value: Name }];
const lbArn = `arn:aws:elasticloadbalancing:${REGION}:${A}:loadbalancer/app/web/abc`;
const tgInstances = `arn:aws:elasticloadbalancing:${REGION}:${A}:targetgroup/web/1`;
const tgIp = `arn:aws:elasticloadbalancing:${REGION}:${A}:targetgroup/api/2`;
const queueArn = `arn:aws:sqs:${REGION}:${A}:orders`;
const fnArn = `arn:aws:lambda:${REGION}:${A}:function:worker`;
const nlbArn = `arn:aws:elasticloadbalancing:${REGION}:${A}:loadbalancer/net/internal/def`;
const cacheArn = `arn:aws:elasticache:${REGION}:${A}:replicationgroup:sessions`;
const restApiArn = `arn:aws:apigateway:${REGION}::/restapis/abc123`;
const cacheCluster = (CacheClusterId: string, extra: Record<string, unknown> = {}) => ({
  CacheClusterId,
  ARN: `arn:aws:elasticache:${REGION}:${A}:cluster:${CacheClusterId}`,
  CacheClusterStatus: "available",
  CacheSubnetGroupName: "cache-subnets",
  SecurityGroups: [{ SecurityGroupId: "sg-cache", Status: "active" }],
  ...extra,
});

/** Workload account: one VPC with public/app/db subnets, attached to account B's transit gateway. */
const workload: Responses = {
  ...empty,
  DescribeVpcsCommand: {
    Vpcs: [
      { VpcId: "vpc-a", OwnerId: A, CidrBlock: "10.0.0.0/16", IsDefault: false, Tags: tag("app") },
      { VpcId: "vpc-default", OwnerId: A, CidrBlock: "172.31.0.0/16", IsDefault: true },
      // Shared to us via RAM: reported by its owner, not here.
      { VpcId: "vpc-shared", OwnerId: "999999999999", CidrBlock: "10.9.0.0/16" },
    ],
  },
  DescribeSubnetsCommand: {
    Subnets: [
      { SubnetId: "subnet-pub", VpcId: "vpc-a", OwnerId: A, AvailabilityZone: "us-east-1a", CidrBlock: "10.0.0.0/24", Tags: tag("app-public-a") },
      { SubnetId: "subnet-app", VpcId: "vpc-a", OwnerId: A, AvailabilityZone: "us-east-1a", CidrBlock: "10.0.1.0/24", Tags: tag("app-private-a") },
      { SubnetId: "subnet-db", VpcId: "vpc-a", OwnerId: A, AvailabilityZone: "us-east-1a", CidrBlock: "10.0.2.0/24", Tags: tag("app-db-a") },
      // Inspection design: the edge subnet's internet route goes through the firewall, whose subnet reaches the IGW.
      { SubnetId: "subnet-fw", VpcId: "vpc-a", OwnerId: A, AvailabilityZone: "us-east-1a", CidrBlock: "10.0.3.0/28", Tags: tag("app-firewall-a") },
      { SubnetId: "subnet-edge", VpcId: "vpc-a", OwnerId: A, AvailabilityZone: "us-east-1a", CidrBlock: "10.0.4.0/24", Tags: tag("app-edge-a") },
      { SubnetId: "subnet-def", VpcId: "vpc-default", OwnerId: A, AvailabilityZone: "us-east-1b", CidrBlock: "172.31.0.0/20" },
    ],
  },
  DescribeInternetGatewaysCommand: {
    InternetGateways: [
      { InternetGatewayId: "igw-a", OwnerId: A, Attachments: [{ VpcId: "vpc-a" }] },
      { InternetGatewayId: "igw-def", OwnerId: A, Attachments: [{ VpcId: "vpc-default" }] },
    ],
  },
  DescribeNatGatewaysCommand: { NatGateways: [{ NatGatewayId: "nat-a", SubnetId: "subnet-pub", VpcId: "vpc-a", State: "available" }] },
  DescribeRouteTablesCommand: {
    RouteTables: [
      // Main table: private and data subnets (no explicit association) go out through NAT, and to the TGW.
      {
        VpcId: "vpc-a",
        OwnerId: A,
        Associations: [{ Main: true }],
        Routes: [
          { NatGatewayId: "nat-a", State: "active" },
          { TransitGatewayId: "tgw-b", State: "active" },
          { GatewayId: "vgw-a", State: "active", Origin: "EnableVgwRoutePropagation" },
          { GatewayId: "local" },
        ],
      },
      { VpcId: "vpc-a", OwnerId: A, Associations: [{ SubnetId: "subnet-pub" }], Routes: [{ GatewayId: "igw-a", State: "active" }] },
      { VpcId: "vpc-a", OwnerId: A, Associations: [{ SubnetId: "subnet-fw" }], Routes: [{ GatewayId: "igw-a", State: "active" }] },
      { VpcId: "vpc-a", OwnerId: A, Associations: [{ SubnetId: "subnet-edge" }], Routes: [{ GatewayId: "vpce-fw-a", State: "active" }] },
      // Ingress routing: traffic arriving at the IGW for the edge subnet goes through the firewall first.
      { VpcId: "vpc-a", OwnerId: A, Associations: [{ GatewayId: "igw-a" }], Routes: [{ GatewayId: "vpce-fw-a", DestinationCidrBlock: "10.0.4.0/24" }, { GatewayId: "local" }] },
      { VpcId: "vpc-default", OwnerId: A, Associations: [{ Main: true }], Routes: [{ GatewayId: "igw-def", State: "active" }] },
    ],
  },
  DescribeTransitGatewayVpcAttachmentsCommand: {
    TransitGatewayVpcAttachments: [{ TransitGatewayAttachmentId: "tgw-attach-1", TransitGatewayId: "tgw-b", VpcId: "vpc-a", State: "available" }],
  },
  ListFirewallsCommand: { Firewalls: [{ FirewallName: "app-fw", FirewallArn: `arn:aws:network-firewall:${REGION}:${A}:firewall/app-fw` }] },
  DescribeFirewallCommand: {
    Firewall: {
      FirewallName: "app-fw",
      FirewallArn: `arn:aws:network-firewall:${REGION}:${A}:firewall/app-fw`,
      FirewallPolicyArn: `arn:aws:network-firewall:${REGION}:${A}:firewall-policy/strict`,
      VpcId: "vpc-a",
      SubnetMappings: [{ SubnetId: "subnet-fw" }],
      DeleteProtection: true,
    },
    FirewallStatus: {
      Status: "READY",
      ConfigurationSyncStateSummary: "IN_SYNC",
      SyncStates: { "us-east-1a": { Attachment: { SubnetId: "subnet-fw", EndpointId: "vpce-fw-a", Status: "READY" } } },
    },
  },
  // A directory in the app VPC; user names and the registration code must stay out of the snapshot.
  DescribeWorkspaceDirectoriesCommand: {
    Directories: [
      {
        DirectoryId: "d-1",
        Alias: "corp",
        DirectoryName: "corp.example.com",
        DirectoryType: "AD_CONNECTOR",
        State: "REGISTERED",
        SubnetIds: ["subnet-app"],
        WorkspaceSecurityGroupId: "sg-ws",
        RegistrationCode: "SLiad+SECRETCODE",
      },
    ],
  },
  DescribeWorkspacesCommand: {
    Workspaces: [
      { WorkspaceId: "ws-1", DirectoryId: "d-1", UserName: "alice", State: "AVAILABLE", SubnetId: "subnet-app", WorkspaceProperties: { RunningMode: "AUTO_STOP", ComputeTypeName: "STANDARD" } },
      { WorkspaceId: "ws-2", DirectoryId: "d-1", UserName: "bob", State: "STOPPED", WorkspaceProperties: { RunningMode: "AUTO_STOP", ComputeTypeName: "STANDARD" } },
      { WorkspaceId: "ws-3", DirectoryId: "d-1", UserName: "carol", State: "UNHEALTHY", WorkspaceProperties: { RunningMode: "ALWAYS_ON", ComputeTypeName: "PERFORMANCE" } },
      { WorkspaceId: "ws-4", DirectoryId: "d-1", UserName: "dave", State: "TERMINATED" },
    ],
  },
  DescribeVpnGatewaysCommand: {
    VpnGateways: [
      { VpnGatewayId: "vgw-a", State: "available", AmazonSideAsn: 64512, VpcAttachments: [{ VpcId: "vpc-a", State: "attached" }], Tags: tag("app-vgw") },
      { VpnGatewayId: "vgw-spare", State: "available", VpcAttachments: [{ VpcId: "vpc-a", State: "detached" }] },
    ],
  },
  DescribeCustomerGatewaysCommand: {
    CustomerGateways: [
      { CustomerGatewayId: "cgw-office", IpAddress: "198.51.100.7", BgpAsn: "65010", DeviceName: "fw-01", State: "available", Tags: tag("office") },
      { CustomerGatewayId: "cgw-partner", IpAddress: "203.0.113.50", BgpAsn: "65000", State: "available" },
    ],
  },
  // Office over BGP with one tunnel down, a partner with static routes, a deleted connection. The responses carry
  // pre-shared keys, which must never reach the snapshot.
  DescribeVpnConnectionsCommand: {
    VpnConnections: [
      {
        VpnConnectionId: "vpn-office",
        CustomerGatewayId: "cgw-office",
        VpnGatewayId: "vgw-a",
        State: "available",
        Type: "ipsec.1",
        Options: { StaticRoutesOnly: false, TunnelOptions: [{ OutsideIpAddress: "52.0.0.1", PreSharedKey: "psk-secret-1" }] },
        CustomerGatewayConfiguration: "<vpn_connection><pre_shared_key>psk-secret-2</pre_shared_key></vpn_connection>",
        VgwTelemetry: [{ Status: "UP" }, { Status: "DOWN" }],
      },
      {
        VpnConnectionId: "vpn-partner",
        CustomerGatewayId: "cgw-partner",
        VpnGatewayId: "vgw-a",
        State: "available",
        Options: { StaticRoutesOnly: true },
        Routes: [{ DestinationCidrBlock: "192.168.10.0/24", State: "available" }],
        VgwTelemetry: [{ Status: "UP" }, { Status: "UP" }],
        Tags: tag("partner"),
      },
      { VpnConnectionId: "vpn-old", CustomerGatewayId: "cgw-office", VpnGatewayId: "vgw-a", State: "deleted" },
    ],
  },
  DescribeInstancesCommand: {
    Reservations: [
      {
        Instances: [
          {
            InstanceId: "i-1",
            SubnetId: "subnet-app",
            State: { Name: "running" },
            InstanceType: "t3.small",
            Tags: tag("app-1"),
            PublicIpAddress: "203.0.113.10",
            SecurityGroups: [{ GroupId: "sg-admin" }, { GroupId: "sg-app" }],
          },
          { InstanceId: "i-2", SubnetId: "subnet-app", State: { Name: "stopped" }, InstanceType: "t3.small", SecurityGroups: [{ GroupId: "sg-app" }] },
        ],
      },
    ],
  },
  DescribeLoadBalancersCommand: {
    LoadBalancers: [
      {
        LoadBalancerArn: lbArn,
        LoadBalancerName: "web",
        Type: "application",
        Scheme: "internet-facing",
        VpcId: "vpc-a",
        State: { Code: "active" },
        SecurityGroups: ["sg-lb"],
        DNSName: "web-123.us-east-1.elb.amazonaws.com",
      },
      { LoadBalancerArn: nlbArn, LoadBalancerName: "internal", Type: "network", Scheme: "internal", VpcId: "vpc-a", State: { Code: "active" } },
    ],
  },
  // Valkey replication group (primary in us-east-1a), a standalone Memcached cluster, a serverless cache.
  DescribeReplicationGroupsCommand: {
    ReplicationGroups: [
      {
        ReplicationGroupId: "sessions",
        ARN: cacheArn,
        Status: "available",
        Engine: "valkey",
        CacheNodeType: "cache.r7g.large",
        MemberClusters: ["sessions-001", "sessions-002"],
        MultiAZ: "enabled",
        NodeGroups: [
          {
            NodeGroupMembers: [
              { CacheClusterId: "sessions-001", CurrentRole: "replica", PreferredAvailabilityZone: "us-east-1b" },
              { CacheClusterId: "sessions-002", CurrentRole: "primary", PreferredAvailabilityZone: "us-east-1a" },
            ],
          },
        ],
      },
    ],
  },
  DescribeCacheClustersCommand: {
    CacheClusters: [
      cacheCluster("sessions-001", { ReplicationGroupId: "sessions", PreferredAvailabilityZone: "us-east-1b", Engine: "valkey", EngineVersion: "8.0" }),
      cacheCluster("sessions-002", { ReplicationGroupId: "sessions", PreferredAvailabilityZone: "us-east-1a", Engine: "valkey", EngineVersion: "8.0" }),
      cacheCluster("lookup", { Engine: "memcached", NumCacheNodes: 2, PreferredAvailabilityZone: "Multiple" }),
    ],
  },
  DescribeCacheSubnetGroupsCommand: {
    CacheSubnetGroups: [
      {
        CacheSubnetGroupName: "cache-subnets",
        VpcId: "vpc-a",
        Subnets: [
          { SubnetIdentifier: "subnet-app", SubnetAvailabilityZone: { Name: "us-east-1b" } },
          { SubnetIdentifier: "subnet-db", SubnetAvailabilityZone: { Name: "us-east-1a" } },
        ],
      },
    ],
  },
  DescribeServerlessCachesCommand: {
    ServerlessCaches: [
      { ServerlessCacheName: "ephemeral", ARN: `arn:aws:elasticache:${REGION}:${A}:serverlesscache:ephemeral`, Status: "available", Engine: "valkey", SubnetIds: ["subnet-app"], SecurityGroupIds: ["sg-cache"] },
    ],
  },
  // REST API: a Lambda proxy, a VPC link to the NLB, and a direct SQS integration.
  GetRestApisCommand: { items: [{ id: "abc123", name: "orders-api", endpointConfiguration: { types: ["REGIONAL"] } }] },
  GetVpcLinksCommand: { items: [{ id: "vl-1", targetArns: [nlbArn] }] },
  GetResourcesCommand: (input: Record<string, unknown>) => {
    assert.deepEqual([input.restApiId, input.embed], ["abc123", ["methods"]]);
    return {
      items: [
        {
          id: "r1",
          path: "/orders",
          resourceMethods: {
            POST: { methodIntegration: { type: "AWS_PROXY", uri: `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${fnArn}/invocations` } },
            GET: { methodIntegration: { type: "HTTP_PROXY", connectionType: "VPC_LINK", connectionId: "vl-1", uri: "http://internal.example" } },
            PUT: { methodIntegration: { type: "AWS", uri: `arn:aws:apigateway:${REGION}:sqs:path/${A}/orders` } },
            // Stage variables can't be resolved: ignored.
            DELETE: { methodIntegration: { type: "AWS_PROXY", uri: "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${stageVariables.fn}/invocations" } },
          },
        },
      ],
    };
  },
  // HTTP and WebSocket APIs, over two pages.
  GetApisCommand: (input: Record<string, unknown>) =>
    input.NextToken
      ? { Items: [{ ApiId: "ws1", Name: "events-ws", ProtocolType: "WEBSOCKET" }] }
      : { Items: [{ ApiId: "h1", Name: "public-api", ProtocolType: "HTTP", ApiEndpoint: "https://h1.execute-api.us-east-1.amazonaws.com" }], NextToken: "p2" },
  GetIntegrationsCommand: (input: Record<string, unknown>) =>
    input.ApiId === "h1"
      ? {
          Items: [
            { IntegrationType: "AWS_PROXY", IntegrationUri: fnArn },
            { IntegrationType: "HTTP_PROXY", ConnectionType: "VPC_LINK", IntegrationUri: `arn:aws:elasticloadbalancing:${REGION}:${A}:listener/app/web/abc/l1` },
          ],
        }
      : { Items: [] },
  DescribeTargetGroupsCommand: {
    TargetGroups: [
      { TargetGroupArn: tgInstances, TargetType: "instance", LoadBalancerArns: [lbArn] },
      { TargetGroupArn: tgIp, TargetType: "ip", LoadBalancerArns: [lbArn] },
    ],
  },
  DescribeTargetHealthCommand: (input: Record<string, unknown>) => {
    assert.equal(input.TargetGroupArn, tgInstances, "IP target groups are not expanded");
    return {
      TargetHealthDescriptions: [
        { Target: { Id: "i-1" }, TargetHealth: { State: "healthy" } },
        { Target: { Id: "i-2" }, TargetHealth: { State: "unhealthy" } },
      ],
    };
  },
  "ecs.ListClustersCommand": { clusterArns: [`arn:aws:ecs:${REGION}:${A}:cluster/main`] },
  // EKS is deliberately not allowed: it must become a warning, not a failed run.
  "eks.ListClustersCommand": undefined,
  ListServicesCommand: { serviceArns: [`arn:aws:ecs:${REGION}:${A}:service/main/api`] },
  DescribeServicesCommand: {
    services: [
      {
        serviceArn: `arn:aws:ecs:${REGION}:${A}:service/main/api`,
        serviceName: "api",
        status: "ACTIVE",
        launchType: "FARGATE",
        desiredCount: 3,
        runningCount: 2,
        networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-app"], securityGroups: ["sg-app"], assignPublicIp: "DISABLED" } },
        loadBalancers: [{ targetGroupArn: tgIp }],
      },
    ],
  },
  ListFunctionsCommand: { Functions: [{ FunctionArn: fnArn, FunctionName: "worker", Runtime: "nodejs22.x", VpcConfig: { SubnetIds: ["subnet-app"], SecurityGroupIds: ["sg-app"] } }] },
  ListEventSourceMappingsCommand: { EventSourceMappings: [{ EventSourceArn: queueArn, FunctionArn: `${fnArn}:live`, State: "Enabled" }] },
  ListQueuesCommand: { QueueUrls: [`https://sqs.${REGION}.amazonaws.com/${A}/orders`] },
  DescribeDBInstancesCommand: {
    DBInstances: [
      {
        DBInstanceArn: `arn:aws:rds:${REGION}:${A}:db:orders`,
        DBInstanceIdentifier: "orders",
        Engine: "postgres",
        DBInstanceStatus: "available",
        AvailabilityZone: "us-east-1a",
        DBSubnetGroup: { Subnets: [{ SubnetIdentifier: "subnet-db", SubnetAvailabilityZone: { Name: "us-east-1a" } }] },
        VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-db", Status: "active" }],
      },
      {
        DBInstanceArn: `arn:aws:rds:${REGION}:${A}:db:orders-replica`,
        DBInstanceIdentifier: "orders-replica",
        Engine: "postgres",
        DBInstanceStatus: "storage-full",
        ReadReplicaSourceDBInstanceIdentifier: "orders",
        DBSubnetGroup: { Subnets: [{ SubnetIdentifier: "subnet-db" }] },
      },
    ],
  },
  ListTablesCommand: { TableNames: ["state"] },
  DescribeTableCommand: { Table: { TableArn: `arn:aws:dynamodb:${REGION}:${A}:table/state`, TableName: "state", TableStatus: "ACTIVE" } },
  DescribeSecurityGroupsCommand: {
    SecurityGroups: [
      {
        GroupId: "sg-admin",
        GroupName: "admin",
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, Ipv6Ranges: [{ CidrIpv6: "::/0" }] },
        ],
      },
      { GroupId: "sg-app", GroupName: "app", IpPermissions: [{ IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: "sg-lb" }] }] },
      // Typical database group: the app group, plus itself (replication); world-open, but the database isn't public.
      {
        GroupId: "sg-db",
        GroupName: "db",
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: "sg-app" }, { GroupId: "sg-db" }, { GroupId: "sg-ws" }] },
          { IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        ],
      },
      { GroupId: "sg-lb", GroupName: "lb", IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] },
      { GroupId: "sg-ws", GroupName: "workspaces", IpPermissions: [] },
      { GroupId: "sg-cache", GroupName: "cache", IpPermissions: [{ IpProtocol: "tcp", FromPort: 6379, ToPort: 6379, UserIdGroupPairs: [{ GroupId: "sg-app" }] }] },
    ],
  },
  DescribeAlarmsCommand: (input: Record<string, unknown>) => {
    assert.equal(input.StateValue, "ALARM");
    const alarm = (AlarmName: string, Namespace: string, Name: string, Value: string) => ({ AlarmName, Namespace, Dimensions: [{ Name, Value }] });
    return {
      MetricAlarms: [
        alarm("orders-cpu", "AWS/RDS", "DBInstanceIdentifier", "orders"),
        alarm("web-5xx", "AWS/ApplicationELB", "LoadBalancer", "app/web/abc"),
        alarm("billing", "AWS/Billing", "Currency", "USD"),
        alarm("gone", "AWS/EC2", "InstanceId", "i-deleted"),
        alarm("sessions-memory", "AWS/ElastiCache", "CacheClusterId", "sessions-001"),
        alarm("orders-api-5xx", "AWS/ApiGateway", "ApiName", "orders-api"),
        alarm("partner-tunnel", "AWS/VPN", "VpnId", "vpn-partner"),
        alarm("fw-drops", "AWS/NetworkFirewall", "FirewallName", "app-fw"),
        // Metric math: the alarm watches the queue through one of its metrics.
        {
          AlarmName: "backlog",
          Metrics: [{ Id: "m1", MetricStat: { Metric: { Namespace: "AWS/SQS", Dimensions: [{ Name: "QueueName", Value: "orders" }] } } }],
        },
      ],
    };
  },
};

/** Network hub account: owns the transit gateway. */
const hub: Responses = {
  ...empty,
  DescribeTransitGatewaysCommand: {
    TransitGateways: [{ TransitGatewayId: "tgw-b", TransitGatewayArn: `arn:aws:ec2:${REGION}:${B}:transit-gateway/tgw-b`, OwnerId: B, State: "available" }],
  },
  // A firewall attached straight to the transit gateway, one endpoint failed.
  ListFirewallsCommand: { Firewalls: [{ FirewallName: "hub-fw", FirewallArn: `arn:aws:network-firewall:${REGION}:${B}:firewall/hub-fw` }] },
  DescribeFirewallCommand: {
    Firewall: { FirewallName: "hub-fw", FirewallArn: `arn:aws:network-firewall:${REGION}:${B}:firewall/hub-fw`, TransitGatewayId: "tgw-b" },
    FirewallStatus: {
      Status: "READY",
      ConfigurationSyncStateSummary: "IN_SYNC",
      SyncStates: { "us-east-1a": { Attachment: { EndpointId: "vpce-hub", Status: "FAILED" } } },
      TransitGatewayAttachmentSyncState: { AttachmentId: "tgw-attach-fw", TransitGatewayAttachmentStatus: "READY" },
    },
  },
  // WorkSpaces isn't offered in every region: the endpoint doesn't resolve, which isn't a warning.
  DescribeWorkspaceDirectoriesCommand: () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND workspaces.us-east-1.amazonaws.com"), { code: "ENOTFOUND" });
  },
  DescribeWorkspacesCommand: () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND workspaces.us-east-1.amazonaws.com"), { code: "ENOTFOUND" });
  },
  // A data centre on the transit gateway, both tunnels down.
  DescribeCustomerGatewaysCommand: { CustomerGateways: [{ CustomerGatewayId: "cgw-dc", IpAddress: "192.0.2.1", Tags: tag("datacenter") }] },
  DescribeVpnConnectionsCommand: {
    VpnConnections: [
      { VpnConnectionId: "vpn-dc", CustomerGatewayId: "cgw-dc", TransitGatewayId: "tgw-b", State: "available", VgwTelemetry: [{ Status: "DOWN" }, { Status: "DOWN" }] },
    ],
  },
};

const distributionArn = `arn:aws:cloudfront::${A}:distribution/E2QWRUHEXAMPLE`;
const distribution = {
  Id: "E2QWRUHEXAMPLE",
  ARN: distributionArn,
  DomainName: "d111111abcdef8.cloudfront.net",
  Status: "Deployed",
  Enabled: true,
  Aliases: { Quantity: 1, Items: ["www.example.com"] },
  Origins: {
    Quantity: 4,
    Items: [
      { Id: "assets", DomainName: "assets.s3.us-east-1.amazonaws.com" },
      { Id: "web", DomainName: "dualstack.WEB-123.us-east-1.elb.amazonaws.com" },
      { Id: "api", DomainName: "abc123.execute-api.us-east-1.amazonaws.com" },
      // A custom domain: nothing Mizar can resolve.
      { Id: "legacy", DomainName: "origin.example.com" },
    ],
  },
};

async function collect(): Promise<{ graph: InfraGraph; warnings: string[] }> {
  const b = new GraphBuilder();
  const security = new SecurityGroups();
  const warnings: string[] = [];
  b.add({ id: "org", type: "organization", name: "org", status: "ok", tags: {}, meta: {} });
  for (const [accountId, responses] of [[A, workload], [B, hub]] as const) {
    const nodeId = `account/${accountId}`;
    b.add({ id: nodeId, type: "account", name: accountId, parentId: "org", accountId, status: "ok", tags: {}, meta: {} });
    const ctx: AccountContext = {
      b,
      accountId,
      nodeId,
      partition: "aws",
      security,
      attempt: async (service, region, fn) => {
        try {
          return await fn();
        } catch (error) {
          warnings.push(`${accountId} ${service}: ${(error as Error).message}`);
        }
      },
    };
    const clients = fakeClients(responses);
    await collectRegion(ctx, REGION, clients);
    destroyClients(clients);
    if (accountId === A) {
      mapBuckets(ctx, [{ name: "assets", region: REGION }]);
      const cloudfront = cloudFrontClient("us-east-1", async () => ({ accessKeyId: "test", secretAccessKey: "test" }));
      (cloudfront as unknown as { send: (cmd: object) => Promise<unknown> }).send = async (cmd) => {
        assert.equal(cmd.constructor.name, "ListDistributionsCommand");
        return { DistributionList: { Items: [distribution] } };
      };
      await collectDistributions(ctx, cloudfront, "us-east-1");
      cloudfront.destroy();
    }
  }
  security.apply(b);
  const { nodes, edges } = b.build();
  return { graph: { version: 1, source: "aws", generatedAt: new Date(0).toISOString(), nodes, edges }, warnings };
}

test("collectRegion maps SDK responses into a valid graph", async () => {
  const { graph, warnings } = await collect();
  assert.deepEqual(validateGraph(graph), []);
  assert.deepEqual(warnings, [`${A} eks: not allowed: ListClustersCommand`]);

  const index = indexGraph(graph);
  const get = (id: string) => index.byId.get(id)!;
  const parentName = (id: string) => index.byId.get(get(id).parentId!)!.name;
  const ec2 = (r: string, account = A) => `arn:aws:ec2:${REGION}:${account}:${r}`;

  // Containment
  assert.equal(parentName(ec2("vpc/vpc-a")), REGION);
  assert.equal(parentName(ec2("subnet/subnet-app")), "app");
  assert.equal(parentName(ec2("instance/i-1")), "app-private-a");
  assert.equal(parentName(ec2("natgateway/nat-a")), "app-public-a");
  assert.equal(parentName(lbArn), "app", "load balancers sit in their VPC");
  assert.equal(parentName(`arn:aws:ecs:${REGION}:${A}:service/main/api`), "app", "ECS services sit in their VPC");
  assert.equal(parentName(fnArn), "app-private-a");
  assert.equal(parentName(`arn:aws:rds:${REGION}:${A}:db:orders`), "app-db-a");
  assert.equal(parentName(queueArn), REGION);
  assert.equal(parentName(cacheArn), "app-db-a", "replication groups sit in their primary's subnet");
  assert.equal(parentName(`arn:aws:elasticache:${REGION}:${A}:cluster:lookup`), "app-private-a");
  assert.equal(parentName(`arn:aws:elasticache:${REGION}:${A}:serverlesscache:ephemeral`), "app", "serverless caches sit in their VPC");
  assert.ok(!index.byId.has(`arn:aws:elasticache:${REGION}:${A}:cluster:sessions-001`), "member clusters fold into their group");
  assert.equal(parentName(restApiArn), REGION);
  assert.equal(parentName(distributionArn), "us-east-1");
  assert.deepEqual(
    graph.nodes.filter((n) => n.type === "api-gateway").map((n) => [n.name, n.meta.protocol]).sort(),
    [["events-ws", "WEBSOCKET"], ["orders-api", "REST"], ["public-api", "HTTP"]],
  );
  assert.deepEqual(get(cacheArn).meta, {
    engine: "valkey",
    engineVersion: "8.0",
    nodeType: "cache.r7g.large",
    members: 2,
    multiAz: true,
    state: "available",
    securityGroups: "cache",
    alarms: "sessions-memory",
    alarmsCount: 1,
  });
  assert.equal(get(distributionArn).name, "www.example.com");
  assert.ok(!index.byId.has(ec2("vpc/vpc-default")), "unused default VPC hidden");
  assert.ok(!index.byId.has(ec2("vpc/vpc-shared")) && !index.byId.has(ec2("vpc/vpc-shared", "999999999999")));

  // Tiers and statuses
  assert.equal(get(ec2("subnet/subnet-pub")).meta.tier, "public");
  assert.equal(get(ec2("subnet/subnet-app")).meta.tier, "private");
  assert.equal(get(ec2("subnet/subnet-db")).meta.tier, "data");
  assert.equal(get(ec2("instance/i-2")).status, "stopped");
  assert.equal(get(lbArn).meta.unhealthyTargets, 1);
  assert.equal(get(`arn:aws:ecs:${REGION}:${A}:service/main/api`).status, "warning", "2 of 3 tasks running");
  assert.equal(get(`arn:aws:rds:${REGION}:${A}:db:orders-replica`).status, "critical");

  // Relationships, including into the other account
  const tgw = ec2("transit-gateway/tgw-b", B);
  const edges = new Set(graph.edges.map((e) => `${e.kind} ${get(e.from).name} → ${get(e.to).name}`));
  for (const expected of [
    "routes app-public-a → igw-a",
    "routes app-private-a → nat-a",
    "routes app-db-a → nat-a",
    `routes app-private-a → tgw-b`,
    "tgw-attachment app → tgw-b",
    "routes app-private-a → app-vgw",
    "vpn office → app-vgw",
    "vpn partner → app-vgw",
    "vpn datacenter → tgw-b",
    "routes app-edge-a → app-fw",
    "routes igw-a → app-fw",
    "routes app-firewall-a → igw-a",
    "tgw-attachment hub-fw → tgw-b",
    "connects corp → orders",
    "targets web → app-1",
    "targets web → i-2",
    "targets web → api",
    "invokes orders → worker",
    "connects orders → orders-replica",
    "connects app-1 → orders",
    "connects i-2 → orders",
    "connects api → orders",
    "connects worker → orders",
    "connects app-1 → sessions",
    "connects api → sessions",
    "connects worker → ephemeral",
    "invokes orders-api → worker",
    "invokes orders-api → internal",
    "invokes orders-api → orders",
    "invokes public-api → worker",
    "invokes public-api → web",
    "targets www.example.com → assets",
    "targets www.example.com → web",
    "targets www.example.com → orders-api",
  ]) {
    assert.ok(edges.has(expected), `missing edge: ${expected}\n  have: ${[...edges].join("\n        ")}`);
  }
  assert.equal(get(tgw).accountId, B);
  assert.equal(graph.edges.filter((e) => e.kind === "routes" && get(e.from).name === "app-public-a").length, 1, "explicit association overrides main");
});

test("Site-to-Site VPN: gateways in their VPC, connections with their customer gateway and tunnel status", async () => {
  const { graph } = await collect();
  const index = indexGraph(graph);
  const get = (id: string) => index.byId.get(id)!;
  const vpn = (id: string, account = A) => get(`arn:aws:ec2:${REGION}:${account}:vpn-connection/${id}`);

  assert.equal(get(get(`arn:aws:ec2:${REGION}:${A}:vpn-gateway/vgw-a`).parentId!).name, "app");
  assert.equal(get(`arn:aws:ec2:${REGION}:${A}:vpn-gateway/vgw-spare`).parentId, `region/${A}/${REGION}`, "detached gateways sit in their region");
  assert.equal(vpn("vpn-office").parentId, `region/${A}/${REGION}`);
  assert.deepEqual(vpn("vpn-office").meta, {
    vpnId: "vpn-office",
    state: "available",
    tunnels: 2,
    tunnelsUp: 1,
    routing: "bgp",
    customerGatewayId: "cgw-office",
    customerGateway: "office",
    customerGatewayIp: "198.51.100.7",
    customerGatewayAsn: "65010",
    customerGatewayDevice: "fw-01",
  });
  assert.equal(vpn("vpn-office").status, "warning", "one tunnel down");
  assert.equal(vpn("vpn-partner").meta.staticRoutes, "192.168.10.0/24");
  assert.equal(vpn("vpn-partner").status, "critical", "firing tunnel alarm");
  assert.equal(vpn("vpn-partner").meta.alarms, "partner-tunnel");
  assert.equal(vpn("vpn-dc", B).status, "critical", "all tunnels down");
  assert.ok(!index.byId.has(`arn:aws:ec2:${REGION}:${A}:vpn-connection/vpn-old`), "deleted connections are skipped");
  assert.ok(!JSON.stringify(graph).includes("psk-secret"), "pre-shared keys never reach the snapshot");
});

test("Network Firewall: endpoints carry routes, inspected subnets stay public, status from endpoints", async () => {
  const { graph } = await collect();
  const index = indexGraph(graph);
  const get = (id: string) => index.byId.get(id)!;
  const app = get(`arn:aws:network-firewall:${REGION}:${A}:firewall/app-fw`);
  const hub = get(`arn:aws:network-firewall:${REGION}:${B}:firewall/hub-fw`);

  assert.equal(get(app.parentId!).name, "app");
  assert.deepEqual(app.meta, {
    policy: "strict",
    endpoints: 1,
    zones: "us-east-1a",
    state: "READY",
    configSync: "IN_SYNC",
    deleteProtection: true,
    alarms: "fw-drops",
    alarmsCount: 1,
  });
  assert.equal(get(`arn:aws:ec2:${REGION}:${A}:subnet/subnet-edge`).meta.tier, "public", "internet route through the firewall");
  assert.equal(get(`arn:aws:ec2:${REGION}:${A}:subnet/subnet-fw`).meta.tier, "public");
  assert.equal(hub.parentId, `region/${B}/${REGION}`, "transit gateway firewalls have no VPC of their own");
  assert.equal(hub.status, "critical", "an endpoint failed");
});

test("WorkSpaces: one node per directory with counts, no user names", async () => {
  const { graph } = await collect();
  const index = indexGraph(graph);
  const get = (id: string) => index.byId.get(id)!;
  const corp = get(`arn:aws:workspaces:${REGION}:${A}:directoryid/d-1`);

  assert.equal(corp.name, "corp");
  assert.equal(get(corp.parentId!).name, "app", "WorkSpaces sit in the directory's VPC");
  assert.equal(corp.status, "warning", "one unhealthy WorkSpace");
  assert.deepEqual(corp.meta, {
    directoryId: "d-1",
    directoryName: "corp.example.com",
    directoryType: "AD_CONNECTOR",
    state: "REGISTERED",
    workspaces: 3,
    available: 1,
    stopped: 1,
    unhealthy: 1,
    runningModes: "AUTO_STOP 2, ALWAYS_ON 1",
    computeTypes: "STANDARD 2, PERFORMANCE 1",
    securityGroups: "workspaces",
  });
  const json = JSON.stringify(graph);
  for (const secret of ["alice", "carol", "SECRETCODE"]) assert.ok(!json.includes(secret), `${secret} leaked`);
});

test("collectBuckets places buckets in their region, only for regions in scope", async () => {
  const b = new GraphBuilder();
  b.add({ id: "acct", type: "account", name: A, accountId: A, status: "ok", tags: {}, meta: {} });
  const s3 = s3Client(REGION, async () => ({ accessKeyId: "test", secretAccessKey: "test" }));
  (s3 as unknown as { send: (cmd: { input: Record<string, unknown> }) => Promise<unknown> }).send = async ({ input }) => ({
    // Like the real API: BucketRegion is omitted unless the request carries a parameter.
    Buckets: [
      { Name: "logs", ...(input.MaxBuckets ? { BucketRegion: REGION } : {}) },
      { Name: "elsewhere", ...(input.MaxBuckets ? { BucketRegion: "ap-south-1" } : {}) },
    ],
  });
  const ctx: AccountContext = { b, accountId: A, nodeId: "acct", partition: "aws", security: new SecurityGroups(), attempt: (_s, _r, fn) => fn() };
  await collectBuckets(ctx, s3, REGION, new Set([REGION]));
  s3.destroy();

  const buckets = b.build().nodes.filter((n) => n.type === "s3");
  assert.deepEqual(buckets.map((n) => [n.id, n.parentId]), [["arn:aws:s3:::logs", `region/${A}/${REGION}`]]);
});

test("security groups: exposure only for public resources, sensitive ports raise a warning", async () => {
  const { graph } = await collect();
  const get = (id: string) => graph.nodes.find((n) => n.id === id)!;
  const instance = get(`arn:aws:ec2:${REGION}:${A}:instance/i-1`);
  assert.equal(instance.meta.securityGroups, "admin, app");
  assert.equal(instance.meta.internetIngress, "tcp/22, tcp/8080");
  assert.equal(instance.meta.exposure, "SSH (tcp/22) open to the internet");
  assert.equal(instance.status, "warning");

  // World-open "all traffic", but not publicly accessible: not exposed.
  const db = get(`arn:aws:rds:${REGION}:${A}:db:orders`);
  assert.equal(db.meta.internetIngress, undefined);
  assert.equal(db.meta.exposure, undefined);

  // Internet-facing load balancer on 443: listed, not a finding.
  assert.equal(get(lbArn).meta.internetIngress, "tcp/443");
  assert.equal(get(lbArn).meta.exposure, undefined);

  // The self-reference on the database group doesn't make the database "connect" to itself.
  assert.ok(!graph.edges.some((e) => e.kind === "connects" && e.from === e.to));
});

test("alarms: firing alarms mark their resource critical; others surface on the account", async () => {
  const { graph } = await collect();
  const get = (id: string) => graph.nodes.find((n) => n.id === id)!;
  assert.equal(get(`arn:aws:rds:${REGION}:${A}:db:orders`).status, "critical");
  assert.equal(get(`arn:aws:rds:${REGION}:${A}:db:orders`).meta.alarms, "orders-cpu");
  assert.equal(get(lbArn).status, "critical");
  assert.equal(get(queueArn).meta.alarms, "backlog");
  assert.equal(get(cacheArn).status, "critical", "an alarm on a member cluster marks its group");
  assert.equal(get(restApiArn).status, "critical", "REST API alarms name the API");

  const account = get(`account/${A}`);
  assert.equal(account.status, "warning");
  assert.equal(account.meta.otherAlarms, `billing (${REGION}); gone (${REGION})`);
  assert.equal(account.meta.otherAlarmsCount, 2);
});

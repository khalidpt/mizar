import type { Resource as RestResource, RestApi } from "@aws-sdk/client-api-gateway";
import type { Api, Integration as HttpIntegration } from "@aws-sdk/client-apigatewayv2";
import type { DistributionSummary } from "@aws-sdk/client-cloudfront";
import type { MetricAlarm } from "@aws-sdk/client-cloudwatch";
import type { TableDescription } from "@aws-sdk/client-dynamodb";
import type {
  CustomerGateway,
  Instance,
  InternetGateway,
  NatGateway,
  RouteTable,
  SecurityGroup,
  Subnet,
  TransitGateway,
  Vpc,
  VpcPeeringConnection,
  VpnConnection,
  VpnGateway,
} from "@aws-sdk/client-ec2";
import type { Service } from "@aws-sdk/client-ecs";
import type { Cluster } from "@aws-sdk/client-eks";
import type { LoadBalancer, TargetHealthDescription } from "@aws-sdk/client-elastic-load-balancing-v2";
import type { CacheCluster, CacheSubnetGroup, ReplicationGroup, ServerlessCache } from "@aws-sdk/client-elasticache";
import type { EventSourceMappingConfiguration, FunctionConfiguration } from "@aws-sdk/client-lambda";
import type { Firewall, FirewallStatus } from "@aws-sdk/client-network-firewall";
import type { DBInstance } from "@aws-sdk/client-rds";
import type { Workspace, WorkspaceDirectory } from "@aws-sdk/client-workspaces";
import type { NodeStatus, NodeType } from "@/lib/graph/types";
import { alarmTargets, apiNameRef, apiRef, cacheRef, distributionRef, elbRef, firewallRef, markAlarm, workspacesRef } from "./alarms";
import type { GraphBuilder } from "./builder";
import type { SecurityGroups } from "./security";
import { arn, tagRecord } from "./util";

/**
 * SDK-shaped records → graph nodes and edges, for one account + region. Both inventory backends feed these: the
 * direct collector with API responses, the Config collector with configuration items adapted to the same shapes.
 * So filters that the direct collector also applies server-side (instance state, peering status, ...) live here too.
 */

/** What every mapper needs: where to write, and whose resources these are. */
export interface AccountContext {
  b: GraphBuilder;
  accountId: string;
  /** Node id of the account (containment parent of its regions). */
  nodeId: string;
  partition: string;
  /** Shared across accounts; applied once collection is complete. */
  security: SecurityGroups;
  /** Runs one API family; on failure records a warning and returns `undefined` instead of throwing. */
  attempt<T>(service: string, region: string, fn: () => Promise<T>): Promise<T | undefined>;
}

/** `ec2:<id>` aliases let other accounts' resources reference VPCs, subnets, gateways and instances by AWS id. */
export const ec2Ref = (id: string) => `ec2:${id}`;

export function regionNode(ctx: AccountContext, region: string): string {
  const id = `region/${ctx.accountId}/${region}`;
  if (!ctx.b.has(id)) {
    ctx.b.add({ id, type: "region", name: region, parentId: ctx.nodeId, accountId: ctx.accountId, region, status: "ok", tags: {}, meta: {} });
  }
  return id;
}

interface NewResource {
  id: string;
  type: NodeType;
  name: string;
  region: string;
  status?: NodeStatus;
  tags?: Record<string, string>;
  /** Undefined and empty values are dropped. */
  meta?: Record<string, string | number | boolean | undefined>;
  az?: string;
  /** Resolved at build time; the region node is the fallback. */
  parentRef?: string;
  refs?: string[];
  /** Security group ids, and whether the resource has a public address (so world-open rules expose it). */
  securityGroups?: { ids: (string | undefined)[] | undefined; isPublic: boolean };
}

function resource(ctx: AccountContext, r: NewResource): void {
  const meta = Object.fromEntries(
    Object.entries(r.meta ?? {}).filter((e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== ""),
  );
  ctx.b.add(
    {
      id: r.id,
      type: r.type,
      name: r.name,
      parentId: regionNode(ctx, r.region),
      accountId: ctx.accountId,
      region: r.region,
      ...(r.az ? { az: r.az } : {}),
      status: r.status ?? "ok",
      tags: r.tags ?? {},
      meta,
    },
    { refs: r.refs, parentRef: r.parentRef },
  );
  if (r.securityGroups) ctx.security.attach(r.id, r.type, r.securityGroups.ids, r.securityGroups.isPublic);
}

const by = <K extends string>(map: Partial<Record<K, NodeStatus>>, fallback: NodeStatus) => (value: string | undefined) =>
  (value && map[value as K]) || fallback;

const instanceStatus = by({ running: "ok", stopped: "stopped", stopping: "stopped", pending: "warning" }, "warning");
const lbStatus = by({ active: "ok", provisioning: "warning", active_impaired: "warning", failed: "critical" }, "warning");
const eksStatus = by({ ACTIVE: "ok", FAILED: "critical" }, "warning");
const natStatus = by({ available: "ok", failed: "critical" }, "warning");
const tableStatus = by({ ACTIVE: "ok", INACCESSIBLE_ENCRYPTION_CREDENTIALS: "critical" }, "warning");
const cacheStatus = by(
  { available: "ok", snapshotting: "ok", "create-failed": "critical", "incompatible-network": "critical", "restore-failed": "critical" },
  "warning",
);

export function rdsStatus(status: string | undefined): NodeStatus {
  if (!status) return "warning";
  if (["available", "backing-up", "storage-optimization", "maintenance"].includes(status)) return "ok";
  if (status === "stopped" || status === "stopping") return "stopped";
  if (status === "failed" || status === "storage-full" || status.startsWith("incompatible") || status.startsWith("inaccessible")) return "critical";
  return "warning";
}

/** `running` is unknown when the service came from AWS Config (it records configuration, not task counts). */
export function ecsStatus(desired = 0, running?: number): NodeStatus {
  if (desired === 0) return "stopped";
  if (running === undefined) return "ok";
  if (running === 0) return "critical";
  return running < desired ? "warning" : "ok";
}

// ── EC2 networking + instances ───────────────────────────────────────────────

const ec2Arn = (ctx: AccountContext, region: string, resource: string) => arn(ctx.partition, "ec2", region, ctx.accountId, resource);
/** Shared VPCs, subnets and gateways (RAM) are also listed in participant accounts; only the owner reports them. */
const owned = (ctx: AccountContext, owner: string | undefined) => !owner || owner === ctx.accountId;

export function mapVpcs(ctx: AccountContext, region: string, vpcs: readonly Vpc[]): void {
  for (const vpc of vpcs) {
    if (!vpc.VpcId || !owned(ctx, vpc.OwnerId)) continue;
    const tags = tagRecord(vpc.Tags);
    resource(ctx, {
      id: ec2Arn(ctx, region, `vpc/${vpc.VpcId}`),
      type: "vpc",
      name: tags.Name || vpc.VpcId,
      region,
      tags,
      meta: { vpcId: vpc.VpcId, cidr: vpc.CidrBlock, isDefault: vpc.IsDefault ?? false },
      refs: [ec2Ref(vpc.VpcId)],
    });
  }
}

export function mapSubnets(ctx: AccountContext, region: string, subnets: readonly Subnet[]): void {
  for (const subnet of subnets) {
    if (!subnet.SubnetId || !owned(ctx, subnet.OwnerId)) continue;
    const tags = tagRecord(subnet.Tags);
    resource(ctx, {
      id: subnet.SubnetArn ?? ec2Arn(ctx, region, `subnet/${subnet.SubnetId}`),
      type: "subnet",
      name: tags.Name || subnet.SubnetId,
      region,
      az: subnet.AvailabilityZone,
      tags,
      // `tier` is inferred from routes when the graph is built.
      meta: { subnetId: subnet.SubnetId, cidr: subnet.CidrBlock, mapPublicIp: subnet.MapPublicIpOnLaunch ?? false },
      parentRef: subnet.VpcId && ec2Ref(subnet.VpcId),
      refs: [ec2Ref(subnet.SubnetId)],
    });
  }
}

export function mapSecurityGroups(ctx: AccountContext, groups: readonly SecurityGroup[]): void {
  ctx.security.addGroups(groups);
}

export function mapInternetGateways(ctx: AccountContext, region: string, igws: readonly InternetGateway[]): void {
  for (const igw of igws) {
    if (!igw.InternetGatewayId || !owned(ctx, igw.OwnerId)) continue;
    const tags = tagRecord(igw.Tags);
    const vpcId = igw.Attachments?.[0]?.VpcId;
    resource(ctx, {
      id: ec2Arn(ctx, region, `internet-gateway/${igw.InternetGatewayId}`),
      type: "igw",
      name: tags.Name || igw.InternetGatewayId,
      region,
      tags,
      meta: { igwId: igw.InternetGatewayId },
      parentRef: vpcId && ec2Ref(vpcId),
      refs: [ec2Ref(igw.InternetGatewayId)],
    });
  }
}

export function mapNatGateways(ctx: AccountContext, region: string, nats: readonly NatGateway[]): void {
  for (const nat of nats) {
    if (!nat.NatGatewayId || nat.State === "deleted" || nat.State === "deleting") continue;
    const tags = tagRecord(nat.Tags);
    resource(ctx, {
      id: ec2Arn(ctx, region, `natgateway/${nat.NatGatewayId}`),
      type: "nat-gateway",
      name: tags.Name || nat.NatGatewayId,
      region,
      status: natStatus(nat.State),
      tags,
      meta: { natId: nat.NatGatewayId, connectivity: nat.ConnectivityType, state: nat.State },
      parentRef: nat.SubnetId && ec2Ref(nat.SubnetId),
      refs: [ec2Ref(nat.NatGatewayId)],
    });
  }
}

export function mapTransitGateways(ctx: AccountContext, region: string, tgws: readonly TransitGateway[]): void {
  for (const tgw of tgws) {
    if (!tgw.TransitGatewayId || !owned(ctx, tgw.OwnerId) || tgw.State === "deleted" || tgw.State === "deleting") continue;
    const tags = tagRecord(tgw.Tags);
    resource(ctx, {
      id: tgw.TransitGatewayArn ?? ec2Arn(ctx, region, `transit-gateway/${tgw.TransitGatewayId}`),
      type: "tgw",
      name: tags.Name || tgw.TransitGatewayId,
      region,
      status: !tgw.State || tgw.State === "available" ? "ok" : "warning",
      tags,
      meta: { tgwId: tgw.TransitGatewayId, amazonSideAsn: tgw.Options?.AmazonSideAsn, state: tgw.State },
      refs: [ec2Ref(tgw.TransitGatewayId)],
    });
  }
}

const GONE = new Set(["terminated", "shutting-down"]);

export function mapInstances(ctx: AccountContext, region: string, instances: readonly Instance[]): void {
  for (const instance of instances) {
    if (!instance.InstanceId || GONE.has(instance.State?.Name ?? "")) continue;
    const tags = tagRecord(instance.Tags);
    resource(ctx, {
      id: ec2Arn(ctx, region, `instance/${instance.InstanceId}`),
      type: "ec2",
      name: tags.Name || instance.InstanceId,
      region,
      status: instanceStatus(instance.State?.Name),
      tags,
      meta: {
        instanceId: instance.InstanceId,
        instanceType: instance.InstanceType,
        state: instance.State?.Name,
        privateIp: instance.PrivateIpAddress,
        publicIp: instance.PublicIpAddress,
        az: instance.Placement?.AvailabilityZone,
        platform: instance.PlatformDetails,
      },
      parentRef: instance.SubnetId && ec2Ref(instance.SubnetId),
      refs: [ec2Ref(instance.InstanceId)],
      securityGroups: { ids: instance.SecurityGroups?.map((g) => g.GroupId), isPublic: !!instance.PublicIpAddress },
    });
  }
}

/**
 * `subnets`: the region's subnets, to apply each VPC's main route table to subnets without an explicit association.
 * Tables associated with a gateway (ingress routing) link that gateway. Endpoint targets (`vpce-`) resolve only for
 * Network Firewall endpoints; other endpoints (Gateway Load Balancer, ...) aren't modelled, so those edges drop.
 */
export function mapRouteTables(ctx: AccountContext, tables: readonly RouteTable[], subnets: readonly Subnet[]): void {
  const subnetsByVpc = new Map<string, Subnet[]>();
  for (const s of subnets) if (s.VpcId) subnetsByVpc.set(s.VpcId, [...(subnetsByVpc.get(s.VpcId) ?? []), s]);
  const explicit = new Set(tables.flatMap((t) => t.Associations ?? []).flatMap((a) => (a.SubnetId ? [a.SubnetId] : [])));

  for (const table of tables) {
    if (!owned(ctx, table.OwnerId)) continue;
    const main = table.Associations?.some((a) => a.Main) && table.VpcId;
    const subnetIds = [
      ...(table.Associations ?? []).flatMap((a) => (a.SubnetId ? [a.SubnetId] : [])),
      ...(main ? (subnetsByVpc.get(main) ?? []).flatMap((s) => (s.SubnetId && !explicit.has(s.SubnetId) ? [s.SubnetId] : [])) : []),
    ];
    const targets = new Set(
      (table.Routes ?? [])
        .filter((r) => r.State !== "blackhole")
        .flatMap((r) => [/^(igw|vgw|vpce)-/.test(r.GatewayId ?? "") ? r.GatewayId : undefined, r.NatGatewayId, r.TransitGatewayId])
        .filter((id): id is string => !!id),
    );
    const gatewayIds = (table.Associations ?? []).flatMap((a) => (a.GatewayId ? [a.GatewayId] : []));
    for (const from of [...subnetIds, ...gatewayIds]) for (const target of targets) ctx.b.link("routes", ec2Ref(from), ec2Ref(target));
  }
}

export function mapPeerings(ctx: AccountContext, peerings: readonly VpcPeeringConnection[]): void {
  for (const pcx of peerings) {
    if (pcx.Status?.Code && pcx.Status.Code !== "active") continue;
    const from = pcx.RequesterVpcInfo?.VpcId;
    const to = pcx.AccepterVpcInfo?.VpcId;
    if (from && to) ctx.b.link("peering", ec2Ref(from), ec2Ref(to), pcx.VpcPeeringConnectionId);
  }
}

export interface TgwAttachment {
  TransitGatewayAttachmentId?: string;
  TransitGatewayId?: string;
  VpcId?: string;
  State?: string;
}

export function mapTgwAttachments(ctx: AccountContext, attachments: readonly TgwAttachment[]): void {
  for (const a of attachments) {
    if (a.State && !["available", "pending", "modifying"].includes(a.State)) continue;
    if (a.VpcId && a.TransitGatewayId) ctx.b.link("tgw-attachment", ec2Ref(a.VpcId), ec2Ref(a.TransitGatewayId), a.TransitGatewayAttachmentId);
  }
}

// ── Site-to-Site VPN ─────────────────────────────────────────────────────────

/** Virtual private gateways sit in the VPC they are attached to; detached ones in their region. */
export function mapVpnGateways(ctx: AccountContext, region: string, gateways: readonly VpnGateway[]): void {
  for (const vgw of gateways) {
    if (!vgw.VpnGatewayId || vgw.State === "deleted" || vgw.State === "deleting") continue;
    const tags = tagRecord(vgw.Tags);
    const vpcId = vgw.VpcAttachments?.find((a) => a.State === "attached" || a.State === "attaching")?.VpcId;
    resource(ctx, {
      id: ec2Arn(ctx, region, `vpn-gateway/${vgw.VpnGatewayId}`),
      type: "vpn-gateway",
      name: tags.Name || vgw.VpnGatewayId,
      region,
      status: !vgw.State || vgw.State === "available" ? "ok" : "warning",
      tags,
      meta: { vgwId: vgw.VpnGatewayId, amazonSideAsn: vgw.AmazonSideAsn, state: vgw.State, attached: !!vpcId },
      parentRef: vpcId && ec2Ref(vpcId),
      refs: [ec2Ref(vgw.VpnGatewayId)],
    });
  }
}

/** No telemetry (AWS Config's record) leaves only the state; one tunnel down is degraded, all down is an outage. */
export function vpnStatus(state: string | undefined, tunnels: number, up: number): NodeStatus {
  if (state && state !== "available") return "warning";
  if (!tunnels) return "ok";
  return up === 0 ? "critical" : up < tunnels ? "warning" : "ok";
}

/**
 * One node per Site-to-Site VPN connection, in its region, with a `vpn` edge to the virtual private gateway or
 * transit gateway it terminates on. The far end, a customer gateway (the office or data centre router), is folded
 * into the node's meta. The API response also carries the tunnels' pre-shared keys (`CustomerGatewayConfiguration`,
 * `Options.TunnelOptions`): only the fields below are read, never those.
 */
export function mapVpnConnections(
  ctx: AccountContext,
  region: string,
  connections: readonly VpnConnection[],
  customerGateways: readonly CustomerGateway[],
): void {
  const cgws = new Map(customerGateways.map((g) => [g.CustomerGatewayId, g]));
  for (const vpn of connections) {
    if (!vpn.VpnConnectionId || vpn.State === "deleted" || vpn.State === "deleting") continue;
    const tags = tagRecord(vpn.Tags);
    const cgw = cgws.get(vpn.CustomerGatewayId);
    const cgwName = tagRecord(cgw?.Tags).Name;
    const tunnels = vpn.VgwTelemetry ?? [];
    const up = tunnels.filter((t) => t.Status === "UP").length;
    const staticOnly = vpn.Options?.StaticRoutesOnly;
    const id = ec2Arn(ctx, region, `vpn-connection/${vpn.VpnConnectionId}`);
    resource(ctx, {
      id,
      type: "vpn-connection",
      name: tags.Name || cgwName || vpn.VpnConnectionId,
      region,
      status: vpnStatus(vpn.State, tunnels.length, up),
      tags,
      meta: {
        vpnId: vpn.VpnConnectionId,
        state: vpn.State,
        tunnels: tunnels.length || undefined,
        tunnelsUp: tunnels.length ? up : undefined,
        routing: staticOnly === undefined ? undefined : staticOnly ? "static" : "bgp",
        staticRoutes: vpn.Routes?.filter((r) => r.State !== "deleted" && r.State !== "deleting")
          .map((r) => r.DestinationCidrBlock)
          .join(", "),
        customerGatewayId: vpn.CustomerGatewayId,
        customerGateway: cgwName,
        customerGatewayIp: cgw?.IpAddress,
        customerGatewayAsn: cgw?.BgpAsn,
        customerGatewayDevice: cgw?.DeviceName,
        accelerated: vpn.Options?.EnableAcceleration || undefined,
        coreNetwork: vpn.CoreNetworkArn,
      },
      refs: [ec2Ref(vpn.VpnConnectionId)],
    });
    const gateway = vpn.VpnGatewayId ?? vpn.TransitGatewayId;
    if (gateway) ctx.b.link("vpn", id, ec2Ref(gateway));
  }
}

// ── Network Firewall ─────────────────────────────────────────────────────────

export interface FirewallRecord {
  firewall: Firewall;
  /** Live status; AWS Config's record has none, only endpoint ids. */
  status?: FirewallStatus;
}

const BROKEN = new Set(["FAILED", "ERROR"]);

export function firewallStatus(status: FirewallStatus | undefined): NodeStatus {
  const attachments = Object.values(status?.SyncStates ?? {}).map((s) => s.Attachment?.Status);
  const tgw = status?.TransitGatewayAttachmentSyncState?.TransitGatewayAttachmentStatus;
  if (status?.Status === "FAILED" || attachments.some((a) => a && BROKEN.has(a)) || (tgw && BROKEN.has(tgw))) return "critical";
  if (status?.Status && status.Status !== "READY") return "warning";
  if (status?.ConfigurationSyncStateSummary && status.ConfigurationSyncStateSummary !== "IN_SYNC") return "warning";
  if (attachments.some((a) => a && a !== "READY" && a !== "SCALING")) return "warning";
  return "ok";
}

/**
 * One node per firewall, in its VPC, or in its region when attached straight to a transit gateway (AWS then owns
 * the VPC). Each endpoint id is a ref, so subnet and gateway routes to `vpce-…` link the firewall, and the subnets
 * the endpoints sit in tell tier inference where inspected traffic goes next. Rules and policies aren't read.
 */
export function mapFirewalls(ctx: AccountContext, region: string, records: readonly FirewallRecord[]): void {
  for (const { firewall: fw, status } of records) {
    if (!fw.FirewallArn || !fw.FirewallName || status?.Status === "DELETING") continue;
    const attachments = Object.entries(status?.SyncStates ?? {}).flatMap(([az, s]) => (s.Attachment ? [{ az, ...s.Attachment }] : []));
    const endpoints = attachments.flatMap((a) => a.EndpointId ?? []);
    const subnets = [...(fw.SubnetMappings ?? []).flatMap((m) => m.SubnetId ?? []), ...attachments.flatMap((a) => a.SubnetId ?? [])];
    resource(ctx, {
      id: fw.FirewallArn,
      type: "network-firewall",
      name: fw.FirewallName,
      region,
      status: firewallStatus(status),
      tags: tagRecord(fw.Tags),
      meta: {
        policy: fw.FirewallPolicyArn?.split("/").pop(),
        endpoints: endpoints.length || undefined,
        zones: [...new Set(attachments.map((a) => a.az))].sort().join(", "),
        state: status?.Status,
        configSync: status?.ConfigurationSyncStateSummary,
        transitGateway: fw.TransitGatewayId,
        deleteProtection: fw.DeleteProtection,
        description: fw.Description,
      },
      parentRef: fw.VpcId ? ec2Ref(fw.VpcId) : undefined,
      refs: [firewallRef({ accountId: ctx.accountId, region }, fw.FirewallName), ...endpoints.map(ec2Ref)],
    });
    ctx.b.endpointsIn(fw.FirewallArn, [...new Set(subnets)].map(ec2Ref));
    if (fw.TransitGatewayId) {
      const attachment = status?.TransitGatewayAttachmentSyncState?.AttachmentId;
      ctx.b.link("tgw-attachment", fw.FirewallArn, ec2Ref(fw.TransitGatewayId), attachment);
    }
  }
}

// ── Load balancers & containers ──────────────────────────────────────────────

/** CloudFront origins name load balancers by DNS name (optionally `dualstack.`-prefixed). */
const elbDnsRef = (dnsName: string) => `elbdns:${dnsName.toLowerCase().replace(/^dualstack\./, "")}`;

export function mapLoadBalancers(ctx: AccountContext, region: string, lbs: readonly LoadBalancer[]): void {
  for (const lb of lbs) {
    if (!lb.LoadBalancerArn) continue;
    resource(ctx, {
      id: lb.LoadBalancerArn,
      type: "elb",
      name: lb.LoadBalancerName ?? lb.LoadBalancerArn,
      region,
      status: lbStatus(lb.State?.Code),
      meta: { type: lb.Type, scheme: lb.Scheme, dnsName: lb.DNSName, subnets: lb.AvailabilityZones?.length },
      parentRef: lb.VpcId && ec2Ref(lb.VpcId),
      refs: [elbRef(lb.LoadBalancerArn), ...(lb.DNSName ? [elbDnsRef(lb.DNSName)] : [])],
      securityGroups: { ids: lb.SecurityGroups, isPublic: lb.Scheme === "internet-facing" },
    });
  }
}

/** One target group's registered targets: links from its load balancers, and unhealthy targets degrade them. */
export function mapTargetHealth(
  ctx: AccountContext,
  group: { loadBalancerArns: string[]; targetType: string | undefined },
  health: readonly TargetHealthDescription[],
): void {
  for (const { Target: target, TargetHealth: state } of health) {
    if (!target?.Id) continue;
    const to = group.targetType === "instance" ? ec2Ref(target.Id) : target.Id;
    for (const lb of group.loadBalancerArns) ctx.b.link("targets", lb, to);
    if (state?.State !== "unhealthy") continue;
    for (const lb of group.loadBalancerArns) {
      ctx.b.update(lb, (node) => {
        node.meta.unhealthyTargets = Number(node.meta.unhealthyTargets ?? 0) + 1;
        if (node.status === "ok") node.status = "warning";
      });
    }
  }
}

/** `targetGroups`: target group ARN → load balancer ARNs, to link services to their load balancers (may be empty). */
export function mapEcsServices(ctx: AccountContext, region: string, services: readonly Service[], targetGroups: ReadonlyMap<string, string[]>): void {
  for (const svc of services) {
    if (!svc.serviceArn || svc.status === "INACTIVE") continue;
    const awsvpc = svc.networkConfiguration?.awsvpcConfiguration;
    const subnet = awsvpc?.subnets?.[0];
    resource(ctx, {
      id: svc.serviceArn,
      type: "ecs-service",
      name: svc.serviceName ?? svc.serviceArn,
      region,
      status: ecsStatus(svc.desiredCount, svc.runningCount),
      meta: {
        cluster: svc.clusterArn?.split("/").pop(),
        launchType: svc.launchType ?? (svc.capacityProviderStrategy?.length ? "CAPACITY_PROVIDER" : undefined),
        desiredCount: svc.desiredCount,
        runningCount: svc.runningCount,
      },
      // ECS services span subnets, so they sit in their VPC (like the mock), not in one subnet.
      parentRef: subnet && `vpc-of:${ec2Ref(subnet)}`,
      securityGroups: { ids: awsvpc?.securityGroups, isPublic: awsvpc?.assignPublicIp === "ENABLED" },
    });
    for (const { targetGroupArn } of svc.loadBalancers ?? []) {
      for (const lb of (targetGroupArn && targetGroups.get(targetGroupArn)) || []) ctx.b.link("targets", lb, svc.serviceArn);
    }
  }
}

export function mapEksClusters(ctx: AccountContext, region: string, clusters: readonly Cluster[]): void {
  for (const cluster of clusters) {
    if (!cluster.arn) continue;
    const vpc = cluster.resourcesVpcConfig;
    const subnet = vpc?.subnetIds?.[0];
    resource(ctx, {
      id: cluster.arn,
      type: "eks-cluster",
      name: cluster.name ?? cluster.arn,
      region,
      status: eksStatus(cluster.status),
      tags: cluster.tags ?? {},
      meta: { version: cluster.version, platformVersion: cluster.platformVersion, state: cluster.status },
      // AWS Config's record of a cluster has subnets but no VPC id.
      parentRef: vpc?.vpcId ? ec2Ref(vpc.vpcId) : subnet && `vpc-of:${ec2Ref(subnet)}`,
      securityGroups: { ids: [...(vpc?.securityGroupIds ?? []), vpc?.clusterSecurityGroupId], isPublic: false },
    });
  }
}

// ── WorkSpaces ───────────────────────────────────────────────────────────────

const UNHEALTHY = new Set(["ERROR", "UNHEALTHY", "IMPAIRED"]);
const countBy = (values: (string | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
};

/**
 * One node per directory, not per WorkSpace: fleets run to thousands, and the node carries counts instead (so user
 * names stay out of the snapshot). Placed in the directory's VPC; its WorkSpaces security group links desktops to the
 * data stores they reach. WorkSpaces from AWS Config come without a directory or state: counted, in the region.
 */
export function mapWorkspaces(ctx: AccountContext, region: string, directories: readonly WorkspaceDirectory[], workspaces: readonly Workspace[]): void {
  const byDirectory = new Map<string, Workspace[]>();
  for (const ws of workspaces) {
    if (!ws.DirectoryId || ws.State === "TERMINATED" || ws.State === "TERMINATING") continue;
    byDirectory.set(ws.DirectoryId, [...(byDirectory.get(ws.DirectoryId) ?? []), ws]);
  }
  const dirs = new Map(
    directories.filter((d) => d.DirectoryId && d.State !== "DEREGISTERED" && d.State !== "DEREGISTERING").map((d) => [d.DirectoryId!, d]),
  );
  for (const id of new Set([...dirs.keys(), ...byDirectory.keys()])) {
    const dir = dirs.get(id);
    const list = byDirectory.get(id) ?? [];
    const known = list.some((w) => w.State);
    const unhealthy = list.filter((w) => w.State && UNHEALTHY.has(w.State)).length;
    const subnet = dir?.SubnetIds?.[0] ?? list.find((w) => w.SubnetId)?.SubnetId;
    resource(ctx, {
      id: arn(ctx.partition, "workspaces", region, ctx.accountId, `directoryid/${id}`),
      type: "workspaces",
      name: dir?.Alias || dir?.WorkspaceDirectoryName || dir?.DirectoryName || id,
      region,
      status:
        dir?.State === "ERROR" || (unhealthy && unhealthy === list.length)
          ? "critical"
          : unhealthy || (dir?.State && dir.State !== "REGISTERED")
            ? "warning"
            : "ok",
      meta: {
        directoryId: id,
        directoryName: dir?.DirectoryName,
        directoryType: dir?.DirectoryType,
        workspaceType: dir?.WorkspaceType,
        state: dir?.State,
        workspaces: list.length,
        available: known ? list.filter((w) => w.State === "AVAILABLE").length : undefined,
        stopped: known ? list.filter((w) => w.State === "STOPPED").length : undefined,
        unhealthy: known ? unhealthy : undefined,
        runningModes: countBy(list.map((w) => w.WorkspaceProperties?.RunningMode)),
        computeTypes: countBy(list.map((w) => w.WorkspaceProperties?.ComputeTypeName)),
      },
      parentRef: subnet && `vpc-of:${ec2Ref(subnet)}`,
      refs: [workspacesRef(id), ...list.flatMap((w) => (w.WorkspaceId ? [workspacesRef(w.WorkspaceId)] : []))],
      securityGroups: { ids: [dir?.WorkspaceSecurityGroupId], isPublic: false },
    });
  }
}

// ── Serverless & data ────────────────────────────────────────────────────────

/** `arn:aws:lambda:r:a:function:name[:qualifier]` → unqualified function ARN. */
const unqualified = (functionArn: string) => functionArn.split(":").slice(0, 7).join(":");

export function mapFunctions(ctx: AccountContext, region: string, functions: readonly FunctionConfiguration[]): void {
  for (const fn of functions) {
    if (!fn.FunctionArn) continue;
    const subnet = fn.VpcConfig?.SubnetIds?.[0];
    resource(ctx, {
      id: unqualified(fn.FunctionArn),
      type: "lambda",
      name: fn.FunctionName ?? fn.FunctionArn,
      region,
      status: fn.State === "Failed" ? "critical" : "ok",
      meta: { runtime: fn.Runtime ?? fn.PackageType, memoryMb: fn.MemorySize, architecture: fn.Architectures?.[0] },
      parentRef: subnet && ec2Ref(subnet),
      securityGroups: { ids: fn.VpcConfig?.SecurityGroupIds, isPublic: false },
    });
  }
}

export function mapEventSourceMappings(ctx: AccountContext, mappings: readonly EventSourceMappingConfiguration[]): void {
  for (const mapping of mappings) {
    if (!mapping.EventSourceArn || !mapping.FunctionArn || mapping.State === "Disabled") continue;
    // DynamoDB streams point at `table/<name>/stream/<label>`; the table is the node.
    ctx.b.link("invokes", mapping.EventSourceArn.split("/stream/")[0], unqualified(mapping.FunctionArn));
  }
}

export function mapDbInstances(ctx: AccountContext, region: string, dbs: readonly DBInstance[]): void {
  for (const db of dbs) {
    if (!db.DBInstanceArn || db.DBInstanceStatus === "deleting") continue;
    // Prefer the subnet in the instance's own AZ, so multi-AZ subnet groups place it correctly.
    const subnets = db.DBSubnetGroup?.Subnets ?? [];
    const subnet = (subnets.find((s) => s.SubnetAvailabilityZone?.Name === db.AvailabilityZone) ?? subnets[0])?.SubnetIdentifier;
    const source = db.ReadReplicaSourceDBInstanceIdentifier;
    resource(ctx, {
      id: db.DBInstanceArn,
      type: "rds",
      name: db.DBInstanceIdentifier ?? db.DBInstanceArn,
      region,
      status: rdsStatus(db.DBInstanceStatus),
      tags: tagRecord(db.TagList),
      meta: {
        engine: db.Engine,
        engineVersion: db.EngineVersion,
        instanceClass: db.DBInstanceClass,
        state: db.DBInstanceStatus,
        multiAz: db.MultiAZ,
        cluster: db.DBClusterIdentifier,
        role: source ? "replica" : "primary",
        publiclyAccessible: db.PubliclyAccessible,
      },
      parentRef: subnet && ec2Ref(subnet),
      securityGroups: {
        ids: db.VpcSecurityGroups?.filter((g) => g.Status !== "inactive").map((g) => g.VpcSecurityGroupId),
        isPublic: !!db.PubliclyAccessible,
      },
    });
    if (source) {
      const sourceArn = source.startsWith("arn:") ? source : arn(ctx.partition, "rds", region, ctx.accountId, `db:${source}`);
      ctx.b.link("connects", sourceArn, db.DBInstanceArn);
    }
  }
}

export function mapTables(ctx: AccountContext, region: string, tables: readonly TableDescription[]): void {
  for (const t of tables) {
    if (!t.TableArn || t.TableStatus === "DELETING") continue;
    resource(ctx, {
      id: t.TableArn,
      type: "dynamodb",
      name: t.TableName ?? t.TableArn,
      region,
      status: tableStatus(t.TableStatus),
      meta: { billingMode: t.BillingModeSummary?.BillingMode ?? "PROVISIONED", items: t.ItemCount, state: t.TableStatus },
    });
  }
}

// ── Caches ───────────────────────────────────────────────────────────────────

export interface CacheInventory {
  replicationGroups: readonly ReplicationGroup[];
  clusters: readonly CacheCluster[];
  subnetGroups: readonly CacheSubnetGroup[];
}

/**
 * One node per replication group (Redis/Valkey, its member clusters folded in) and per standalone cluster
 * (Memcached, or Redis without a group). Placed like RDS: in the subnet of the primary's Availability Zone.
 */
export function mapCaches(ctx: AccountContext, region: string, inv: CacheInventory): void {
  const scope = { accountId: ctx.accountId, region };
  const subnetGroups = new Map(inv.subnetGroups.map((g) => [g.CacheSubnetGroupName, g]));
  const clusters = new Map(inv.clusters.map((c) => [c.CacheClusterId, c]));
  const subnetOf = (cluster: CacheCluster | undefined) => {
    const subnets = (cluster && subnetGroups.get(cluster.CacheSubnetGroupName)?.Subnets) ?? [];
    return (subnets.find((s) => s.SubnetAvailabilityZone?.Name === cluster?.PreferredAvailabilityZone) ?? subnets[0])?.SubnetIdentifier;
  };
  const groupIds = (members: readonly (CacheCluster | undefined)[]) => members.flatMap((m) => m?.SecurityGroups?.map((g) => g.SecurityGroupId) ?? []);

  for (const rg of inv.replicationGroups) {
    if (!rg.ARN || !rg.ReplicationGroupId || rg.Status === "deleting") continue;
    const memberIds = rg.MemberClusters ?? [];
    const members = memberIds.map((id) => clusters.get(id));
    const primaryId = rg.NodeGroups?.flatMap((g) => g.NodeGroupMembers ?? []).find((m) => m.CurrentRole === "primary")?.CacheClusterId;
    const primary = clusters.get(primaryId) ?? members.find(Boolean);
    const subnet = subnetOf(primary);
    resource(ctx, {
      id: rg.ARN,
      type: "elasticache",
      name: rg.ReplicationGroupId,
      region,
      status: cacheStatus(rg.Status),
      meta: {
        engine: rg.Engine ?? primary?.Engine,
        engineVersion: primary?.EngineVersion,
        nodeType: rg.CacheNodeType,
        members: memberIds.length,
        shards: rg.ClusterEnabled ? rg.NodeGroups?.length : undefined,
        multiAz: rg.MultiAZ === "enabled",
        transitEncryption: rg.TransitEncryptionEnabled,
        atRestEncryption: rg.AtRestEncryptionEnabled,
        state: rg.Status,
      },
      parentRef: subnet && ec2Ref(subnet),
      // Alarms name a member cluster (`<group>-001`) or the group.
      refs: [cacheRef(scope, rg.ReplicationGroupId), ...memberIds.map((id) => cacheRef(scope, id))],
      securityGroups: { ids: groupIds(members), isPublic: false },
    });
  }

  for (const c of inv.clusters) {
    if (c.ReplicationGroupId || !c.ARN || !c.CacheClusterId || c.CacheClusterStatus === "deleting") continue;
    const subnet = subnetOf(c);
    resource(ctx, {
      id: c.ARN,
      type: "elasticache",
      name: c.CacheClusterId,
      region,
      status: cacheStatus(c.CacheClusterStatus),
      meta: { engine: c.Engine, engineVersion: c.EngineVersion, nodeType: c.CacheNodeType, nodes: c.NumCacheNodes, state: c.CacheClusterStatus },
      parentRef: subnet && ec2Ref(subnet),
      refs: [cacheRef(scope, c.CacheClusterId)],
      securityGroups: { ids: groupIds([c]), isPublic: false },
    });
  }
}

/** Serverless caches span subnets, so they sit in their VPC. */
export function mapServerlessCaches(ctx: AccountContext, region: string, caches: readonly ServerlessCache[]): void {
  for (const cache of caches) {
    if (!cache.ARN || !cache.ServerlessCacheName || cache.Status === "deleting") continue;
    const subnet = cache.SubnetIds?.[0];
    resource(ctx, {
      id: cache.ARN,
      type: "elasticache",
      name: cache.ServerlessCacheName,
      region,
      status: cacheStatus(cache.Status),
      meta: { engine: cache.Engine, engineVersion: cache.FullEngineVersion ?? cache.MajorEngineVersion, serverless: true, state: cache.Status },
      parentRef: subnet && `vpc-of:${ec2Ref(subnet)}`,
      refs: [cacheRef({ accountId: ctx.accountId, region }, cache.ServerlessCacheName)],
      securityGroups: { ids: cache.SecurityGroupIds, isPublic: false },
    });
  }
}

// ── APIs & edge ──────────────────────────────────────────────────────────────

const restApiArn = (ctx: AccountContext, region: string, apiId: string) => arn(ctx.partition, "apigateway", region, "", `/restapis/${apiId}`);
const httpApiArn = (ctx: AccountContext, region: string, apiId: string) => arn(ctx.partition, "apigateway", region, "", `/apis/${apiId}`);

export function mapRestApis(ctx: AccountContext, region: string, apis: readonly RestApi[]): void {
  for (const api of apis) {
    if (!api.id) continue;
    resource(ctx, {
      id: restApiArn(ctx, region, api.id),
      type: "api-gateway",
      name: api.name ?? api.id,
      region,
      tags: api.tags ?? {},
      meta: { apiId: api.id, protocol: "REST", endpointType: api.endpointConfiguration?.types?.join(", ") },
      refs: [apiRef(api.id), ...(api.name ? [apiNameRef({ accountId: ctx.accountId, region }, api.name)] : [])],
    });
  }
}

export function mapHttpApis(ctx: AccountContext, region: string, apis: readonly Api[]): void {
  for (const api of apis) {
    if (!api.ApiId) continue;
    resource(ctx, {
      id: httpApiArn(ctx, region, api.ApiId),
      type: "api-gateway",
      name: api.Name ?? api.ApiId,
      region,
      tags: api.Tags ?? {},
      meta: { apiId: api.ApiId, protocol: api.ProtocolType, endpoint: api.ApiEndpoint },
      refs: [apiRef(api.ApiId)],
    });
  }
}

/**
 * What an integration URI calls, as a ref: a Lambda function (`…/functions/<arn>/invocations` or a bare ARN), an
 * SQS queue (`arn:…:apigateway:<region>:sqs:path/<account>/<queue>`) or a load balancer (an HTTP API's VPC link
 * integration names a listener). Anything else (public URLs, other AWS services, stage variables) is not modelled.
 */
export function integrationTarget(uri: string | undefined): string | undefined {
  if (!uri || uri.includes("${")) return undefined;
  const fn = /\/functions\/(arn:[^/]+)\/invocations/.exec(uri)?.[1] ?? (/^arn:[^:]+:lambda:[^:]+:\d{12}:function:/.test(uri) ? uri : undefined);
  if (fn) return unqualified(fn);
  const sqs = /^arn:([^:]+):apigateway:([^:]+):sqs:path\/(\d{12})\/([^/?]+)/.exec(uri);
  if (sqs) return arn(sqs[1], "sqs", sqs[2], sqs[3], sqs[4]);
  const listener = /^(arn:[^:]+:elasticloadbalancing:[^:]+:\d{12}:)listener\/((?:app|net)\/[^/]+\/[^/]+)\//.exec(uri);
  if (listener) return `${listener[1]}loadbalancer/${listener[2]}`;
  return undefined;
}

/** REST API methods (from `GetResources` with `embed=methods`). `vpcLinks`: VPC link id → network load balancer ARNs. */
export function mapRestIntegrations(
  ctx: AccountContext,
  region: string,
  apiId: string,
  resources: readonly RestResource[],
  vpcLinks: ReadonlyMap<string, string[]>,
): void {
  const from = restApiArn(ctx, region, apiId);
  for (const method of resources.flatMap((r) => Object.values(r.resourceMethods ?? {}))) {
    const integration = method.methodIntegration;
    const target = integrationTarget(integration?.uri);
    if (target) ctx.b.link("invokes", from, target);
    if (integration?.connectionType === "VPC_LINK" && integration.connectionId) {
      for (const lb of vpcLinks.get(integration.connectionId) ?? []) ctx.b.link("invokes", from, lb);
    }
  }
}

export function mapHttpIntegrations(ctx: AccountContext, region: string, apiId: string, integrations: readonly HttpIntegration[]): void {
  const from = httpApiArn(ctx, region, apiId);
  for (const integration of integrations) {
    const target = integrationTarget(integration.IntegrationUri);
    if (target) ctx.b.link("invokes", from, target);
  }
}

/** Origin domain → ref: S3 buckets (REST or website endpoints), load balancers, API Gateway APIs. */
export function originTarget(domain: string, partition: string): string | undefined {
  const d = domain.toLowerCase();
  const bucket = /^(.+?)\.s3(?:-website)?(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/.exec(d)?.[1];
  if (bucket) return `arn:${partition}:s3:::${bucket}`;
  if (/\.elb\.amazonaws\.com(?:\.cn)?$/.test(d)) return elbDnsRef(d);
  const api = /^([a-z0-9]+)\.execute-api\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.exec(d)?.[1];
  if (api) return apiRef(api);
  return undefined;
}

/** CloudFront is global: distributions are placed in `region`, the partition's CloudFront region (us-east-1). */
export function mapDistributions(ctx: AccountContext, region: string, distributions: readonly DistributionSummary[]): void {
  for (const d of distributions) {
    if (!d.ARN || !d.Id) continue;
    const aliases = d.Aliases?.Items ?? [];
    resource(ctx, {
      id: d.ARN,
      type: "cloudfront",
      name: aliases[0] ?? d.DomainName ?? d.Id,
      region,
      status: d.Enabled === false ? "stopped" : !d.Status || d.Status === "Deployed" ? "ok" : "warning",
      meta: {
        distributionId: d.Id,
        domainName: d.DomainName,
        aliases: aliases.join(", "),
        priceClass: d.PriceClass,
        enabled: d.Enabled,
        state: d.Status,
        webAcl: d.WebACLId ? true : undefined,
        comment: d.Comment,
      },
      refs: [distributionRef(d.Id)],
    });
    for (const origin of d.Origins?.Items ?? []) {
      const target = origin.DomainName && originTarget(origin.DomainName, ctx.partition);
      if (target) ctx.b.link("targets", d.ARN, target);
    }
  }
}

export function mapQueues(ctx: AccountContext, region: string, names: readonly string[]): void {
  for (const name of names) {
    resource(ctx, { id: arn(ctx.partition, "sqs", region, ctx.accountId, name), type: "sqs", name, region, meta: { fifo: name.endsWith(".fifo") } });
  }
}

export function mapBuckets(ctx: AccountContext, buckets: readonly { name: string; region: string }[]): void {
  for (const { name, region } of buckets) resource(ctx, { id: `arn:${ctx.partition}:s3:::${name}`, type: "s3", name, region });
}

/** Firing metric alarms. Each marks the resource it watches; alarms on unmodelled things mark the account. */
export function mapFiringAlarms(ctx: AccountContext, region: string, alarms: readonly MetricAlarm[]): void {
  for (const alarm of alarms) {
    const name = alarm.AlarmName ?? "alarm";
    const onAccount = () => ctx.b.update(ctx.nodeId, (node) => markAlarm(node, `${name} (${region})`, "otherAlarms"));
    const targets = alarmTargets(alarm, { partition: ctx.partition, accountId: ctx.accountId, region });
    if (!targets.length) onAccount();
    for (const ref of targets) ctx.b.annotate(ref, (node) => markAlarm(node, name), onAccount);
  }
}

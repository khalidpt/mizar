import {
  type ConfigServiceClient,
  paginateDescribeConfigurationAggregatorSourcesStatus,
  paginateSelectAggregateResourceConfig,
} from "@aws-sdk/client-config-service";
import type { RestApi } from "@aws-sdk/client-api-gateway";
import type { Api } from "@aws-sdk/client-apigatewayv2";
import type { DistributionSummary } from "@aws-sdk/client-cloudfront";
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
import type { LoadBalancer } from "@aws-sdk/client-elastic-load-balancing-v2";
import type { FunctionConfiguration } from "@aws-sdk/client-lambda";
import type { Firewall } from "@aws-sdk/client-network-firewall";
import type { DBInstance } from "@aws-sdk/client-rds";
import type { Workspace } from "@aws-sdk/client-workspaces";
import {
  type AccountContext,
  type FirewallRecord,
  mapBuckets,
  mapDbInstances,
  mapDistributions,
  mapEcsServices,
  mapEksClusters,
  mapFirewalls,
  mapFunctions,
  mapHttpApis,
  mapInstances,
  mapInternetGateways,
  mapLoadBalancers,
  mapNatGateways,
  mapPeerings,
  mapQueues,
  mapRestApis,
  mapRouteTables,
  mapSecurityGroups,
  mapSubnets,
  mapTables,
  mapTgwAttachments,
  mapTransitGateways,
  mapVpcs,
  mapVpnConnections,
  mapVpnGateways,
  mapWorkspaces,
  type TgwAttachment,
} from "./map";
import { cloudFrontRegion } from "./session";
import { all, tagRecord } from "./util";

/**
 * AWS Config aggregator inventory: one paginated advanced query in the aggregator account lists every resource in
 * every aggregated account and region, instead of accounts × regions × services API calls.
 *
 * Config items hold each resource's configuration in one of two shapes: the service API's (EC2, ELB, RDS, Lambda,
 * DynamoDB, HTTP APIs, CloudFront; keys with a lower-case first letter, e.g. `dBInstanceArn`) or CloudFormation's
 * (ECS, EKS, SQS, transit gateways; PascalCase). `toSdk*` adapt both to the SDK shapes `map.ts` already handles.
 * Config records no ElastiCache resources and no API Gateway integrations: enrichment lists those directly. VPN
 * tunnel status, firewall endpoint status and WorkSpaces states and directories are live or missing, so enrichment
 * lists VPN connections, firewalls and WorkSpaces directly too.
 */

export const CONFIG_TYPES = [
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::NatGateway",
  "AWS::EC2::TransitGateway",
  "AWS::EC2::TransitGatewayAttachment",
  "AWS::EC2::RouteTable",
  "AWS::EC2::VPCPeeringConnection",
  "AWS::EC2::VPNGateway",
  "AWS::EC2::VPNConnection",
  "AWS::EC2::CustomerGateway",
  "AWS::EC2::Instance",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ECS::Service",
  "AWS::EKS::Cluster",
  "AWS::Lambda::Function",
  "AWS::RDS::DBInstance",
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::S3::Bucket",
  "AWS::CloudWatch::Alarm",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudFront::Distribution",
  "AWS::NetworkFirewall::Firewall",
  "AWS::WorkSpaces::Workspace",
] as const;

/** Global resources: kept whatever `aws.regions` says, and placed in the CloudFront region. */
const GLOBAL_TYPES = new Set<string>(["AWS::CloudFront::Distribution"]);

export type ConfigType = (typeof CONFIG_TYPES)[number];

export interface ConfigItem {
  accountId: string;
  awsRegion: string;
  resourceType: ConfigType;
  resourceId: string;
  resourceName?: string;
  arn?: string;
  tags?: { key?: string; value?: string }[];
  // Config items are untyped JSON; the adapters below give them SDK shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configuration?: any;
  configurationItemStatus?: string;
}

const GONE = new Set(["ResourceDeleted", "ResourceDeletedNotRecorded", "ResourceNotRecorded"]);

export async function queryAggregator(client: ConfigServiceClient, aggregator: string): Promise<ConfigItem[]> {
  const types = CONFIG_TYPES.map((t) => `'${t}'`).join(", ");
  const Expression =
    "SELECT accountId, awsRegion, resourceType, resourceId, resourceName, arn, tags, configuration, configurationItemStatus " +
    `WHERE resourceType IN (${types})`;
  const results = await all(
    paginateSelectAggregateResourceConfig({ client, pageSize: 100 }, { ConfigurationAggregatorName: aggregator, Expression }),
    (page) => page.Results,
  );
  return results.map((r) => JSON.parse(r) as ConfigItem).filter((item) => !GONE.has(item.configurationItemStatus ?? ""));
}

/** Account → aggregation problems: `undefined` when every region syncs, else a reason (never synced, or failing). */
export async function aggregatorCoverage(client: ConfigServiceClient, aggregator: string): Promise<Map<string, string | undefined>> {
  const statuses = await all(
    paginateDescribeConfigurationAggregatorSourcesStatus({ client }, { ConfigurationAggregatorName: aggregator }),
    (page) => page.AggregatedSourceStatusList,
  );
  const coverage = new Map<string, string | undefined>();
  for (const s of statuses) {
    if (s.SourceType !== "ACCOUNT" || !s.SourceId) continue;
    const failing = s.LastUpdateStatus === "FAILED" ? `${s.AwsRegion}: ${s.LastErrorCode ?? "FAILED"}` : undefined;
    if (!coverage.has(s.SourceId) || failing) coverage.set(s.SourceId, failing ?? coverage.get(s.SourceId));
  }
  return coverage;
}

// ── Shape adapters ───────────────────────────────────────────────────────────

type Json = unknown;

function rekey(value: Json, key: (k: string) => string): Json {
  if (Array.isArray(value)) return value.map((v) => rekey(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [key(k), rekey(v, key)]));
  }
  return value;
}

/** Service-API-shaped configuration (`dBInstanceArn`, `vpcId`) → SDK shape (`DBInstanceArn`, `VpcId`). */
export const upperKeys = <T>(value: Json): T => rekey(value, (k) => k.charAt(0).toUpperCase() + k.slice(1)) as T;
/** CloudFormation-shaped configuration (`ServiceArn`) → camelCase SDK shape (`serviceArn`), for ECS and EKS. */
export const lowerKeys = <T>(value: Json): T => rekey(value, (k) => k.charAt(0).toLowerCase() + k.slice(1)) as T;

/** Config records some enums as `{ value: "available" }` where the SDK has `"available"`. */
const unwrap = (v: unknown) => (v && typeof v === "object" && "Value" in v ? (v as { Value: unknown }).Value : v);
const itemTags = (item: ConfigItem) => (item.tags ?? []).map((t) => ({ Key: t.key, Value: t.value }));

export function toSdkSecurityGroup(item: ConfigItem): SecurityGroup {
  const g = upperKeys<Omit<SecurityGroup, "IpPermissions"> & { IpPermissions?: Record<string, unknown>[] }>(item.configuration);
  // Config has both `ipRanges` (plain CIDR strings) and `ipv4Ranges` (`{ cidrIp }`); the SDK's `IpRanges` is the latter.
  const permissions = (g.IpPermissions ?? []).map((p) => ({ ...p, IpRanges: p.Ipv4Ranges ?? [] }));
  return { ...g, IpPermissions: permissions } as SecurityGroup;
}

export function toSdkLoadBalancer(item: ConfigItem): LoadBalancer {
  const lb = upperKeys<LoadBalancer & { SecurityGroups?: unknown[] }>(item.configuration);
  // Security groups may be recorded as strings or as `{ value }`.
  const groups = (lb.SecurityGroups ?? []).map((g) => String(unwrap(g)));
  return { ...lb, LoadBalancerArn: lb.LoadBalancerArn ?? item.arn, SecurityGroups: groups };
}

export function toSdkEcsService(item: ConfigItem): Service {
  const s = lowerKeys<Service & { cluster?: string; name?: string }>(item.configuration);
  return { ...s, serviceArn: s.serviceArn ?? item.arn, serviceName: s.serviceName ?? s.name, clusterArn: s.clusterArn ?? s.cluster };
}

export function toSdkEksCluster(item: ConfigItem): Cluster {
  const c = lowerKeys<Cluster & { clusterStatus?: string }>(item.configuration);
  return { ...c, arn: c.arn ?? item.arn, status: (c.status ?? c.clusterStatus) as Cluster["status"], tags: tagRecord(item.tags) };
}

export function toSdkTransitGateway(item: ConfigItem): TransitGateway {
  const c = item.configuration ?? {};
  return {
    TransitGatewayId: c.Id ?? item.resourceId,
    TransitGatewayArn: item.arn,
    OwnerId: item.accountId,
    Options: { AmazonSideAsn: c.AmazonSideAsn },
    Tags: itemTags(item),
  };
}

export function toSdkTgwAttachment(item: ConfigItem): TgwAttachment {
  const c = item.configuration ?? {};
  return { TransitGatewayAttachmentId: c.Id ?? item.resourceId, TransitGatewayId: c.TransitGatewayId, VpcId: c.VpcId };
}

/** REST APIs are recorded in the SDK's own (camelCase) shape; tags come from the item. */
export function toSdkRestApi(item: ConfigItem): RestApi {
  return { ...(item.configuration as RestApi), id: item.configuration?.id ?? item.resourceId, tags: tagRecord(item.tags) };
}

export function toSdkHttpApi(item: ConfigItem): Api {
  const api = upperKeys<Api>(item.configuration);
  return { ...api, ApiId: api.ApiId ?? item.resourceId, Tags: tagRecord(item.tags) };
}

/** Config records the full distribution (`distributionConfig.origins.items`); the mapper takes a list summary. */
export function toSdkDistribution(item: ConfigItem): DistributionSummary {
  const c = item.configuration ?? {};
  const dc = c.distributionConfig ?? {};
  const aliases: string[] = dc.aliases?.items ?? [];
  const origins: { id?: string; domainName?: string }[] = dc.origins?.items ?? [];
  return {
    Id: c.id ?? item.resourceId,
    ARN: c.arn ?? item.arn,
    DomainName: c.domainName,
    Status: c.status,
    Enabled: dc.enabled,
    Aliases: { Quantity: aliases.length, Items: aliases },
    Origins: { Quantity: origins.length, Items: origins.map((o) => ({ Id: o.id, DomainName: o.domainName })) },
    PriceClass: dc.priceClass,
    WebACLId: dc.webACLId,
    Comment: dc.comment,
  } as DistributionSummary;
}

export function toSdkVpnGateway(item: ConfigItem): VpnGateway {
  const g = upperKeys<VpnGateway & { State?: unknown; VpcAttachments?: { VpcId?: string; State?: unknown }[] }>(item.configuration);
  const attachments = (g.VpcAttachments ?? []).map((a) => ({ VpcId: a.VpcId, State: unwrap(a.State) }));
  return { ...g, VpnGatewayId: g.VpnGatewayId ?? item.resourceId, State: unwrap(g.State), VpcAttachments: attachments, Tags: itemTags(item) } as VpnGateway;
}

/**
 * Only what the mapper reads (the record also holds the tunnels' pre-shared keys). Tunnel telemetry is left out:
 * Config records configuration changes, so its copy may be stale; enrichment supplies the live status.
 */
export function toSdkVpnConnection(item: ConfigItem): VpnConnection {
  const c = upperKeys<VpnConnection & { State?: unknown }>(item.configuration);
  return {
    VpnConnectionId: c.VpnConnectionId ?? item.resourceId,
    CustomerGatewayId: c.CustomerGatewayId,
    VpnGatewayId: c.VpnGatewayId,
    TransitGatewayId: c.TransitGatewayId,
    CoreNetworkArn: c.CoreNetworkArn,
    State: unwrap(c.State),
    Options: c.Options && { StaticRoutesOnly: c.Options.StaticRoutesOnly, EnableAcceleration: c.Options.EnableAcceleration },
    Routes: c.Routes?.map((r) => ({ DestinationCidrBlock: r.DestinationCidrBlock, State: unwrap(r.State) })),
    Tags: itemTags(item),
  } as VpnConnection;
}

export function toSdkCustomerGateway(item: ConfigItem): CustomerGateway {
  const g = upperKeys<CustomerGateway>(item.configuration);
  return { ...g, CustomerGatewayId: g.CustomerGatewayId ?? item.resourceId, Tags: itemTags(item) };
}

/**
 * Endpoints come as `EndpointIds` (`<az>:<vpce-id>`) or a status snapshot; either way only the ids are kept, with no
 * status (Config's copy may be stale). `rekey` capitalised the snapshot's AZ keys, hence the `toLowerCase`.
 */
export function toSdkFirewall(item: ConfigItem): FirewallRecord {
  const c = upperKeys<Firewall & { Firewall?: Firewall; EndpointIds?: string[]; FirewallStatus?: { SyncStates?: Record<string, { Attachment?: { EndpointId?: string } }> } }>(
    item.configuration,
  );
  const fw = c.Firewall ?? c;
  const endpoints: [string, string | undefined][] = c.EndpointIds
    ? c.EndpointIds.map((e) => e.split(":") as [string, string])
    : Object.entries(c.FirewallStatus?.SyncStates ?? {}).map(([az, s]) => [az.toLowerCase(), s.Attachment?.EndpointId]);
  const syncStates = Object.fromEntries(endpoints.filter(([, id]) => id).map(([az, id]) => [az, { Attachment: { EndpointId: id } }]));
  return {
    firewall: {
      FirewallArn: fw.FirewallArn ?? item.arn,
      FirewallName: fw.FirewallName ?? item.resourceName,
      FirewallPolicyArn: fw.FirewallPolicyArn,
      VpcId: fw.VpcId,
      SubnetMappings: fw.SubnetMappings,
      DeleteProtection: fw.DeleteProtection,
      Description: fw.Description,
      TransitGatewayId: fw.TransitGatewayId,
      FirewallId: fw.FirewallId,
      Tags: itemTags(item),
    },
    status: { SyncStates: syncStates } as FirewallRecord["status"],
  };
}

/** Configuration only: no state (stale at best) and no user name. Directories aren't recorded at all. */
export function toSdkWorkspace(item: ConfigItem): Workspace {
  const c = upperKeys<Workspace & { Id?: string }>(item.configuration);
  return { WorkspaceId: c.WorkspaceId ?? c.Id ?? item.resourceId, DirectoryId: c.DirectoryId, BundleId: c.BundleId, WorkspaceProperties: c.WorkspaceProperties };
}

/** Upper-cases keys and unwraps `State: { Value }` to `State: "…"` (VPCs, subnets, NAT gateways, functions). */
function withState<T>(item: ConfigItem): T {
  const r = upperKeys<Record<string, unknown>>(item.configuration);
  return { ...r, State: unwrap(r.State) } as T;
}

/** Peering status may be `{ code }` or a bare string. */
function toSdkPeering(item: ConfigItem): VpcPeeringConnection {
  const p = upperKeys<VpcPeeringConnection & { Status?: unknown }>(item.configuration);
  return { ...p, Status: typeof p.Status === "string" ? { Code: p.Status as never } : (p.Status as VpcPeeringConnection["Status"]) };
}

// ── One account + region ─────────────────────────────────────────────────────

export interface RegionItems {
  region: string;
  byType: Map<ConfigType, ConfigItem[]>;
}

/** Account → region → items, keeping only `accounts` (the collection scope) and, if given, `regions`. */
export function groupItems(items: readonly ConfigItem[], accounts: ReadonlySet<string>, regions: ReadonlySet<string> | undefined) {
  const out = new Map<string, Map<string, RegionItems>>();
  for (const item of items) {
    if (!accounts.has(item.accountId) || (regions && !regions.has(item.awsRegion) && !GLOBAL_TYPES.has(item.resourceType))) continue;
    const byRegion = out.get(item.accountId) ?? new Map<string, RegionItems>();
    out.set(item.accountId, byRegion);
    const entry = byRegion.get(item.awsRegion) ?? { region: item.awsRegion, byType: new Map() };
    byRegion.set(item.awsRegion, entry);
    entry.byType.set(item.resourceType, [...(entry.byType.get(item.resourceType) ?? []), item]);
  }
  return out;
}

/**
 * Maps one account + region of Config items, except ECS services, VPN connections, firewalls and WorkSpaces: those
 * are left to `mapConfigDeferred`, so a direct listing with live state (enrichment) can go first and the Config
 * record only fills in if that fails.
 */
export function mapConfigRegion(ctx: AccountContext, { region, byType }: RegionItems): void {
  const of = (type: ConfigType) => byType.get(type) ?? [];
  const subnets = of("AWS::EC2::Subnet").map((i) => withState<Subnet>(i));

  mapVpcs(ctx, region, of("AWS::EC2::VPC").map((i) => withState<Vpc>(i)));
  mapSubnets(ctx, region, subnets);
  mapSecurityGroups(ctx, of("AWS::EC2::SecurityGroup").map(toSdkSecurityGroup));
  mapInternetGateways(ctx, region, of("AWS::EC2::InternetGateway").map((i) => upperKeys<InternetGateway>(i.configuration)));
  mapNatGateways(ctx, region, of("AWS::EC2::NatGateway").map((i) => withState<NatGateway>(i)));
  mapTransitGateways(ctx, region, of("AWS::EC2::TransitGateway").map(toSdkTransitGateway));
  mapInstances(ctx, region, of("AWS::EC2::Instance").map((i) => upperKeys<Instance>(i.configuration)));
  mapRouteTables(ctx, of("AWS::EC2::RouteTable").map((i) => upperKeys<RouteTable>(i.configuration)), subnets);
  mapPeerings(ctx, of("AWS::EC2::VPCPeeringConnection").map(toSdkPeering));
  mapTgwAttachments(ctx, of("AWS::EC2::TransitGatewayAttachment").map(toSdkTgwAttachment));
  mapVpnGateways(ctx, region, of("AWS::EC2::VPNGateway").map(toSdkVpnGateway));
  mapLoadBalancers(ctx, region, of("AWS::ElasticLoadBalancingV2::LoadBalancer").map(toSdkLoadBalancer));
  mapEksClusters(ctx, region, of("AWS::EKS::Cluster").map(toSdkEksCluster));
  mapFunctions(ctx, region, of("AWS::Lambda::Function").map((i) => withState<FunctionConfiguration>(i)));
  mapDbInstances(
    ctx,
    region,
    of("AWS::RDS::DBInstance").map((i) => ({ ...upperKeys<DBInstance>(i.configuration), TagList: itemTags(i) })),
  );
  mapTables(ctx, region, of("AWS::DynamoDB::Table").map((i) => upperKeys<TableDescription>(i.configuration)));
  mapQueues(ctx, region, of("AWS::SQS::Queue").map((i) => i.configuration?.QueueName ?? i.resourceName ?? i.resourceId));
  mapBuckets(
    ctx,
    of("AWS::S3::Bucket").map((i) => ({ name: i.configuration?.name ?? i.resourceName ?? i.resourceId, region: i.configuration?.region ?? region })),
  );
  mapRestApis(ctx, region, of("AWS::ApiGateway::RestApi").map(toSdkRestApi));
  mapHttpApis(ctx, region, of("AWS::ApiGatewayV2::Api").map(toSdkHttpApi));
  const distributions = of("AWS::CloudFront::Distribution");
  if (distributions.length) mapDistributions(ctx, cloudFrontRegion(ctx.partition) ?? region, distributions.map(toSdkDistribution));
}

export function mapConfigDeferred(ctx: AccountContext, { region, byType }: RegionItems, targetGroups: ReadonlyMap<string, string[]>): void {
  const of = (type: ConfigType) => byType.get(type) ?? [];
  mapEcsServices(ctx, region, of("AWS::ECS::Service").map(toSdkEcsService), targetGroups);
  mapVpnConnections(ctx, region, of("AWS::EC2::VPNConnection").map(toSdkVpnConnection), of("AWS::EC2::CustomerGateway").map(toSdkCustomerGateway));
  mapFirewalls(ctx, region, of("AWS::NetworkFirewall::Firewall").map(toSdkFirewall));
  mapWorkspaces(ctx, region, [], of("AWS::WorkSpaces::Workspace").map(toSdkWorkspace));
}

/** What Config doesn't record, and which direct calls would fill it in for this region. */
export function enrichmentNeeds({ byType }: RegionItems) {
  const has = (type: ConfigType) => (byType.get(type)?.length ?? 0) > 0;
  return {
    targets: has("AWS::ElasticLoadBalancingV2::LoadBalancer"),
    ecs: has("AWS::ECS::Service"),
    eventSources: has("AWS::Lambda::Function"),
    alarms: has("AWS::CloudWatch::Alarm"),
    apis: has("AWS::ApiGateway::RestApi") || has("AWS::ApiGatewayV2::Api"),
    vpn: has("AWS::EC2::VPNConnection"),
    firewalls: has("AWS::NetworkFirewall::Firewall"),
    workspaces: has("AWS::WorkSpaces::Workspace"),
    // Config doesn't record ElastiCache at all. Caches live in VPCs; default VPCs alone (every region) don't count.
    caches: (byType.get("AWS::EC2::VPC") ?? []).some((i) => i.configuration?.isDefault === false),
  };
}

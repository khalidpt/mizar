import { paginateGetResources, paginateGetRestApis, paginateGetVpcLinks } from "@aws-sdk/client-api-gateway";
import { GetApisCommand, GetIntegrationsCommand } from "@aws-sdk/client-apigatewayv2";
import { type CloudFrontClient, paginateListDistributions } from "@aws-sdk/client-cloudfront";
import { paginateDescribeAlarms } from "@aws-sdk/client-cloudwatch";
import { DescribeTableCommand, paginateListTables, type TableDescription } from "@aws-sdk/client-dynamodb";
import {
  DescribeCustomerGatewaysCommand,
  DescribeVpnConnectionsCommand,
  DescribeVpnGatewaysCommand,
  paginateDescribeInstances,
  paginateDescribeInternetGateways,
  paginateDescribeNatGateways,
  paginateDescribeRouteTables,
  paginateDescribeSecurityGroups,
  paginateDescribeSubnets,
  paginateDescribeTransitGateways,
  paginateDescribeTransitGatewayVpcAttachments,
  paginateDescribeVpcPeeringConnections,
  paginateDescribeVpcs,
} from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, paginateListClusters as paginateListEcsClusters, paginateListServices } from "@aws-sdk/client-ecs";
import { type Cluster, DescribeClusterCommand, paginateListClusters as paginateListEksClusters } from "@aws-sdk/client-eks";
import {
  DescribeTargetHealthCommand,
  paginateDescribeLoadBalancers,
  paginateDescribeTargetGroups,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  paginateDescribeCacheClusters,
  paginateDescribeCacheSubnetGroups,
  paginateDescribeReplicationGroups,
  paginateDescribeServerlessCaches,
} from "@aws-sdk/client-elasticache";
import { paginateListEventSourceMappings, paginateListFunctions } from "@aws-sdk/client-lambda";
import { DescribeFirewallCommand, paginateListFirewalls } from "@aws-sdk/client-network-firewall";
import { paginateDescribeDBInstances } from "@aws-sdk/client-rds";
import { paginateListBuckets, type S3Client } from "@aws-sdk/client-s3";
import { paginateListQueues } from "@aws-sdk/client-sqs";
import { paginateDescribeWorkspaceDirectories, paginateDescribeWorkspaces } from "@aws-sdk/client-workspaces";
import {
  type AccountContext,
  mapBuckets,
  mapCaches,
  mapDbInstances,
  mapDistributions,
  mapEcsServices,
  mapEksClusters,
  mapEventSourceMappings,
  type FirewallRecord,
  mapFiringAlarms,
  mapFirewalls,
  mapFunctions,
  mapHttpApis,
  mapHttpIntegrations,
  mapInstances,
  mapInternetGateways,
  mapLoadBalancers,
  mapNatGateways,
  mapPeerings,
  mapQueues,
  mapRestApis,
  mapRestIntegrations,
  mapRouteTables,
  mapSecurityGroups,
  mapServerlessCaches,
  mapSubnets,
  mapTables,
  mapTargetHealth,
  mapTgwAttachments,
  mapTransitGateways,
  mapVpcs,
  mapVpnConnections,
  mapVpnGateways,
  mapWorkspaces,
} from "./map";
import type { RegionClients } from "./session";
import { all, chunks, pages, pool, whereOffered } from "./util";

export type { AccountContext } from "./map";

/**
 * Direct inventory: list everything in one account + region with the service APIs, then map it (`map.ts`).
 * API families run in parallel; dependent ones are chained. A few of these fetchers are also used to enrich the
 * AWS Config inventory with what Config doesn't record (target health, task counts, event sources, alarm state).
 */
export async function collectRegion(ctx: AccountContext, region: string, c: RegionClients): Promise<void> {
  const elb = ctx.attempt("elbv2", region, async () => {
    mapLoadBalancers(ctx, region, await all(paginateDescribeLoadBalancers({ client: c.elb }, {}), (pg) => pg.LoadBalancers));
    return fetchTargetGroups(ctx, region, c);
  });
  await Promise.all([
    collectNetwork(ctx, region, c),
    elb.then((targetGroups) => fetchEcsServices(ctx, region, c, targetGroups ?? new Map())),
    fetchEksClusters(ctx, region, c),
    ctx.attempt("lambda", region, async () => {
      mapFunctions(ctx, region, await all(paginateListFunctions({ client: c.lambda }, {}), (pg) => pg.Functions));
    }),
    fetchEventSourceMappings(ctx, region, c),
    ctx.attempt("rds", region, async () => {
      mapDbInstances(ctx, region, await all(paginateDescribeDBInstances({ client: c.rds }, {}), (pg) => pg.DBInstances));
    }),
    fetchTables(ctx, region, c),
    fetchCaches(ctx, region, c),
    fetchApis(ctx, region, c),
    fetchVpnConnections(ctx, region, c),
    fetchFirewalls(ctx, region, c),
    fetchWorkspaces(ctx, region, c),
    ctx.attempt("sqs", region, async () => {
      const urls = await all(paginateListQueues({ client: c.sqs }, {}), (pg) => pg.QueueUrls);
      mapQueues(ctx, region, urls.map((url) => url.split("/").pop()!));
    }),
    fetchFiringAlarms(ctx, region, c),
  ]);
}

async function collectNetwork(ctx: AccountContext, region: string, { ec2 }: RegionClients): Promise<void> {
  const [vpcs, subnets] = await Promise.all([
    ctx.attempt("ec2:vpcs", region, () => all(paginateDescribeVpcs({ client: ec2 }, {}), (pg) => pg.Vpcs)),
    ctx.attempt("ec2:subnets", region, () => all(paginateDescribeSubnets({ client: ec2 }, {}), (pg) => pg.Subnets)),
  ]);
  mapVpcs(ctx, region, vpcs ?? []);
  mapSubnets(ctx, region, subnets ?? []);

  await Promise.all([
    ctx.attempt("ec2:security-groups", region, async () => {
      mapSecurityGroups(ctx, await all(paginateDescribeSecurityGroups({ client: ec2 }, {}), (pg) => pg.SecurityGroups));
    }),
    ctx.attempt("ec2:internet-gateways", region, async () => {
      mapInternetGateways(ctx, region, await all(paginateDescribeInternetGateways({ client: ec2 }, {}), (pg) => pg.InternetGateways));
    }),
    ctx.attempt("ec2:nat-gateways", region, async () => {
      const filter = [{ Name: "state", Values: ["pending", "available", "failed"] }];
      mapNatGateways(ctx, region, await all(paginateDescribeNatGateways({ client: ec2 }, { Filter: filter }), (pg) => pg.NatGateways));
    }),
    ctx.attempt("ec2:transit-gateways", region, async () => {
      mapTransitGateways(ctx, region, await all(paginateDescribeTransitGateways({ client: ec2 }, {}), (pg) => pg.TransitGateways));
    }),
    ctx.attempt("ec2:vpn-gateways", region, async () => {
      // Not paginated.
      const { VpnGateways = [] } = await ec2.send(new DescribeVpnGatewaysCommand({}));
      mapVpnGateways(ctx, region, VpnGateways);
    }),
    ctx.attempt("ec2:instances", region, async () => {
      const filter = [{ Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }];
      const reservations = await all(paginateDescribeInstances({ client: ec2 }, { Filters: filter }), (pg) => pg.Reservations);
      mapInstances(ctx, region, reservations.flatMap((r) => r.Instances ?? []));
    }),
    ctx.attempt("ec2:route-tables", region, async () => {
      mapRouteTables(ctx, await all(paginateDescribeRouteTables({ client: ec2 }, {}), (pg) => pg.RouteTables), subnets ?? []);
    }),
    ctx.attempt("ec2:vpc-peering", region, async () => {
      const filter = [{ Name: "status-code", Values: ["active"] }];
      mapPeerings(ctx, await all(paginateDescribeVpcPeeringConnections({ client: ec2 }, { Filters: filter }), (pg) => pg.VpcPeeringConnections));
    }),
    ctx.attempt("ec2:tgw-attachments", region, async () => {
      const filter = [{ Name: "state", Values: ["available", "pending", "modifying"] }];
      const input = { Filters: filter };
      mapTgwAttachments(ctx, await all(paginateDescribeTransitGatewayVpcAttachments({ client: ec2 }, input), (pg) => pg.TransitGatewayVpcAttachments));
    }),
  ]);
}

/** Site-to-Site VPN connections with their customer gateways (neither API is paginated). */
export async function fetchVpnConnections(ctx: AccountContext, region: string, { ec2 }: RegionClients) {
  await ctx.attempt("ec2:vpn-connections", region, async () => {
    const [{ VpnConnections = [] }, { CustomerGateways = [] }] = await Promise.all([
      ec2.send(new DescribeVpnConnectionsCommand({})),
      ec2.send(new DescribeCustomerGatewaysCommand({})),
    ]);
    mapVpnConnections(ctx, region, VpnConnections, CustomerGateways);
  });
}

/** Firewalls with their live status (endpoints per Availability Zone). Rules and policies aren't read. */
export async function fetchFirewalls(ctx: AccountContext, region: string, { networkFirewall }: RegionClients) {
  await ctx.attempt("network-firewall", region, () =>
    whereOffered(async () => {
      const firewalls = await all(paginateListFirewalls({ client: networkFirewall }, {}), (pg) => pg.Firewalls);
      const records = await pool(5, firewalls, async ({ FirewallArn }) => {
        const { Firewall, FirewallStatus } = await networkFirewall.send(new DescribeFirewallCommand({ FirewallArn }));
        return Firewall ? [{ firewall: Firewall, status: FirewallStatus }] : [];
      });
      mapFirewalls(ctx, region, records.flat() satisfies FirewallRecord[]);
    }),
  );
}

export async function fetchWorkspaces(ctx: AccountContext, region: string, { workspaces }: RegionClients) {
  await ctx.attempt("workspaces", region, () =>
    whereOffered(async () => {
      const [directories, desktops] = await Promise.all([
        all(paginateDescribeWorkspaceDirectories({ client: workspaces }, {}), (pg) => pg.Directories),
        all(paginateDescribeWorkspaces({ client: workspaces }, {}), (pg) => pg.Workspaces),
      ]);
      mapWorkspaces(ctx, region, directories, desktops);
    }),
  );
}

/**
 * Target groups with their registered targets (instances and Lambda functions; IP targets such as Fargate tasks are
 * linked through their ECS service instead). Returns target group ARN → load balancer ARNs. Throws on API errors.
 */
async function fetchTargetGroups(ctx: AccountContext, region: string, { elb }: RegionClients): Promise<Map<string, string[]>> {
  const targetGroups = new Map<string, string[]>();
  const groups = await all(paginateDescribeTargetGroups({ client: elb }, {}), (pg) => pg.TargetGroups);
  await pool(5, groups, async (tg) => {
    const loadBalancerArns = tg.LoadBalancerArns ?? [];
    if (!tg.TargetGroupArn || !loadBalancerArns.length) return;
    targetGroups.set(tg.TargetGroupArn, loadBalancerArns);
    if (tg.TargetType !== "instance" && tg.TargetType !== "lambda") return;
    const { TargetHealthDescriptions = [] } = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
    mapTargetHealth(ctx, { loadBalancerArns, targetType: tg.TargetType }, TargetHealthDescriptions);
  });
  return targetGroups;
}

export async function fetchLoadBalancerTargets(ctx: AccountContext, region: string, c: RegionClients) {
  return ctx.attempt("elbv2", region, () => fetchTargetGroups(ctx, region, c));
}

export async function fetchEcsServices(ctx: AccountContext, region: string, { ecs }: RegionClients, targetGroups: ReadonlyMap<string, string[]>) {
  await ctx.attempt("ecs", region, async () => {
    const clusters = await all(paginateListEcsClusters({ client: ecs }, {}), (pg) => pg.clusterArns);
    await pool(3, clusters, async (cluster) => {
      const arns = await all(paginateListServices({ client: ecs }, { cluster }), (pg) => pg.serviceArns);
      for (const batch of chunks(arns, 10)) {
        const { services = [] } = await ecs.send(new DescribeServicesCommand({ cluster, services: batch }));
        mapEcsServices(ctx, region, services, targetGroups);
      }
    });
  });
}

async function fetchEksClusters(ctx: AccountContext, region: string, { eks }: RegionClients) {
  await ctx.attempt("eks", region, async () => {
    const names = await all(paginateListEksClusters({ client: eks }, {}), (pg) => pg.clusters);
    const clusters = await pool(3, names, async (name) => (await eks.send(new DescribeClusterCommand({ name }))).cluster);
    mapEksClusters(ctx, region, clusters.filter((c): c is Cluster => !!c));
  });
}

export async function fetchEventSourceMappings(ctx: AccountContext, region: string, { lambda }: RegionClients) {
  await ctx.attempt("lambda:event-sources", region, async () => {
    mapEventSourceMappings(ctx, await all(paginateListEventSourceMappings({ client: lambda }, {}), (pg) => pg.EventSourceMappings));
  });
}

async function fetchTables(ctx: AccountContext, region: string, { dynamodb }: RegionClients) {
  await ctx.attempt("dynamodb", region, async () => {
    const names = await all(paginateListTables({ client: dynamodb }, {}), (pg) => pg.TableNames);
    const tables = await pool(5, names, async (TableName) => (await dynamodb.send(new DescribeTableCommand({ TableName }))).Table);
    mapTables(ctx, region, tables.filter((t): t is TableDescription => !!t));
  });
}

export async function fetchCaches(ctx: AccountContext, region: string, { elasticache }: RegionClients) {
  await Promise.all([
    ctx.attempt("elasticache", region, async () => {
      const [replicationGroups, clusters, subnetGroups] = await Promise.all([
        all(paginateDescribeReplicationGroups({ client: elasticache }, {}), (pg) => pg.ReplicationGroups),
        all(paginateDescribeCacheClusters({ client: elasticache }, {}), (pg) => pg.CacheClusters),
        all(paginateDescribeCacheSubnetGroups({ client: elasticache }, {}), (pg) => pg.CacheSubnetGroups),
      ]);
      mapCaches(ctx, region, { replicationGroups, clusters, subnetGroups });
    }),
    // Separate, so a region without serverless caches doesn't hide the others.
    ctx.attempt("elasticache:serverless", region, async () => {
      mapServerlessCaches(ctx, region, await all(paginateDescribeServerlessCaches({ client: elasticache }, {}), (pg) => pg.ServerlessCaches));
    }),
  ]);
}

/**
 * REST and HTTP/WebSocket APIs with what their integrations call. Also used to enrich AWS Config, which records APIs
 * but not integrations (nodes are added once; the first write wins).
 */
export async function fetchApis(ctx: AccountContext, region: string, { apigateway, apigatewayv2 }: RegionClients) {
  await Promise.all([
    ctx.attempt("apigateway", region, async () => {
      const apis = await all(paginateGetRestApis({ client: apigateway }, {}), (pg) => pg.items);
      mapRestApis(ctx, region, apis);
      if (!apis.length) return;
      const links = await all(paginateGetVpcLinks({ client: apigateway }, {}), (pg) => pg.items);
      const vpcLinks = new Map(links.flatMap((l) => (l.id ? [[l.id, l.targetArns ?? []] as const] : [])));
      // The API Gateway control plane is throttled hard: a couple of APIs at a time.
      await pool(2, apis, async (api) => {
        if (!api.id) return;
        const resources = await all(paginateGetResources({ client: apigateway }, { restApiId: api.id, embed: ["methods"] }), (pg) => pg.items);
        mapRestIntegrations(ctx, region, api.id, resources, vpcLinks);
      });
    }),
    ctx.attempt("apigatewayv2", region, async () => {
      const apis = await pages((NextToken) => apigatewayv2.send(new GetApisCommand({ NextToken })), (r) => r.Items);
      mapHttpApis(ctx, region, apis);
      await pool(2, apis, async (api) => {
        if (!api.ApiId) return;
        const ApiId = api.ApiId;
        const integrations = await pages((NextToken) => apigatewayv2.send(new GetIntegrationsCommand({ ApiId, NextToken })), (r) => r.Items);
        mapHttpIntegrations(ctx, region, ApiId, integrations);
      });
    }),
  ]);
}

export async function fetchFiringAlarms(ctx: AccountContext, region: string, { cloudwatch }: RegionClients) {
  await ctx.attempt("cloudwatch", region, async () => {
    const input = { StateValue: "ALARM" as const, AlarmTypes: ["MetricAlarm" as const] };
    mapFiringAlarms(ctx, region, await all(paginateDescribeAlarms({ client: cloudwatch }, input), (pg) => pg.MetricAlarms));
  });
}

/** CloudFront is global: one listing per account, every distribution placed in `region` (the CloudFront region). */
export async function collectDistributions(ctx: AccountContext, cloudfront: CloudFrontClient, region: string) {
  await ctx.attempt("cloudfront", "global", async () => {
    const lists = await all(paginateListDistributions({ client: cloudfront }, {}), (pg) => (pg.DistributionList ? [pg.DistributionList] : []));
    mapDistributions(ctx, region, lists.flatMap((l) => l.Items ?? []));
  });
}

/** S3 is global: one listing per account, each bucket placed in its own region (when that region is in scope). */
export async function collectBuckets(ctx: AccountContext, s3: S3Client, homeRegion: string, regions: ReadonlySet<string>) {
  await ctx.attempt("s3", homeRegion, async () => {
    // S3 only includes `BucketRegion` when the request has at least one parameter, so always send a page size.
    const buckets = await all(paginateListBuckets({ client: s3, pageSize: 1000 }, {}), (pg) => pg.Buckets);
    mapBuckets(
      ctx,
      buckets.flatMap((b) => (b.Name && b.BucketRegion && regions.has(b.BucketRegion) ? [{ name: b.Name, region: b.BucketRegion }] : [])),
    );
  });
}

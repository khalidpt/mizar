import { cents, formatTopServices } from "./cost";
import type { EdgeKind, Environment, GraphEdge, GraphNode, InfraGraph, NodeStatus, NodeType } from "./types";

/**
 * Deterministic mock AWS Organization shaped like a typical landing zone:
 * management account, Security OU (log archive, audit), Infrastructure OU (shared network with
 * transit gateways + egress VPCs, shared services), Workloads OU (prod / non-prod accounts per team),
 * Sandbox OU and an empty-ish Suspended OU. Same options → byte-identical graph.
 */
export interface MockOptions {
  seed?: number;
  /** Product teams; each gets prod, staging and dev accounts. Raise it to stress-test renderers. */
  teams?: number;
  sandboxes?: number;
  generatedAt?: string;
  /** Spend per account and region, as the AWS collector's `aws.cost` adds it. */
  costs?: boolean;
}

const TEAM_NAMES = [
  "payments", "checkout", "catalog", "identity", "search", "analytics",
  "messaging", "billing", "fulfillment", "recommendations", "media", "notifications",
];
const PRIMARY_REGION = "us-east-1";
const DR_REGION = "eu-west-1";
const SANDBOX_REGIONS = ["us-west-2", "eu-central-1", "ap-southeast-2"];

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += "0123456789abcdef"[this.int(0, 15)];
    return s;
  }
  lower(length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[this.int(0, 35)];
    return s;
  }
  digits(length: number): string {
    let s = String(this.int(1, 9));
    for (let i = 1; i < length; i++) s += String(this.int(0, 9));
    return s;
  }
}

interface Account {
  id: string;
  name: string;
  env: Environment;
  node: GraphNode;
}

type Tier = "public" | "private" | "data";

interface Network {
  vpc: GraphNode;
  subnets: Record<Tier, GraphNode[]>;
  igw?: GraphNode;
}

type NewNode = Omit<GraphNode, "status" | "tags" | "meta"> & Partial<Pick<GraphNode, "status" | "tags" | "meta">>;

export function generateMockGraph(options: MockOptions = {}): InfraGraph {
  const { seed = 42, teams = 4, sandboxes = 2, generatedAt = "2026-10-15T00:00:00.000Z", costs = true } = options;
  const rng = new Rng(seed);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const regionNodes = new Map<string, GraphNode>();
  const usedAccountIds = new Set<string>();
  let cidrBlock = 0;

  const add = (node: NewNode): GraphNode => {
    const full: GraphNode = { status: "ok", tags: {}, meta: {}, ...node };
    nodes.push(full);
    return full;
  };
  const link = (kind: EdgeKind, from: GraphNode, to: GraphNode) => {
    edges.push({ id: `e${edges.length}`, kind, from: from.id, to: to.id });
  };
  /** Mostly healthy, with the occasional alarm; stoppable resources are sometimes stopped. */
  const health = (stoppedChance = 0): NodeStatus => {
    if (rng.chance(stoppedChance)) return "stopped";
    const roll = rng.next();
    return roll < 0.015 ? "critical" : roll < 0.07 ? "warning" : "ok";
  };
  const newAccountId = (): string => {
    let id: string;
    do id = rng.digits(12);
    while (usedAccountIds.has(id));
    usedAccountIds.add(id);
    return id;
  };

  // ── Organization structure ────────────────────────────────────────────────

  const mgmtId = newAccountId();
  const orgId = `o-${rng.lower(10)}`;
  const orgArn = (kind: string, id: string) => `arn:aws:organizations::${mgmtId}:${kind}/${orgId}/${id}`;

  const org = add({
    id: `arn:aws:organizations::${mgmtId}:organization/${orgId}`,
    type: "organization",
    name: "Mizar Demo Org",
    meta: { orgId, featureSet: "ALL", managementAccountId: mgmtId },
  });

  const rootSuffix = rng.lower(4);
  const ou = (name: string, parent: GraphNode): GraphNode =>
    add({ id: orgArn("ou", `ou-${rootSuffix}-${rng.lower(8)}`), type: "ou", name, parentId: parent.id });

  const account = (name: string, env: Environment, parent: GraphNode, id = newAccountId()): Account => {
    const node = add({
      id: orgArn("account", id),
      type: "account",
      name,
      parentId: parent.id,
      accountId: id,
      tags: { Environment: env },
      meta: { email: `aws+${name}@example.com`, joinedMethod: id === mgmtId ? "CREATED" : "INVITED" },
    });
    return { id, name, env, node };
  };

  const region = (acct: Account, name: string): GraphNode => {
    const key = `${acct.id}/${name}`;
    let node = regionNodes.get(key);
    if (!node) {
      node = add({ id: `region/${key}`, type: "region", name, parentId: acct.node.id, accountId: acct.id, region: name });
      regionNodes.set(key, node);
    }
    return node;
  };

  // ── Resource helpers ──────────────────────────────────────────────────────

  const arn = (service: string, acct: Account, regionName: string, resource: string) =>
    `arn:aws:${service}:${regionName}:${acct.id}:${resource}`;
  const tagsFor = (acct: Account, extra: Record<string, string> = {}) => ({ Environment: acct.env, ...extra });

  const network = (acct: Account, regionName: string, name: string, azCount: number, tiers: Tier[]): Network => {
    // /20 per VPC, /24 per subnet: room for 4096 VPCs before 10/8 runs out.
    const block = cidrBlock++;
    const base = `10.${Math.floor(block / 16)}.${(block % 16) * 16}`;
    const regionNode = region(acct, regionName);
    const vpcId = `vpc-${rng.hex(17)}`;
    const vpc = add({
      id: arn("ec2", acct, regionName, `vpc/${vpcId}`),
      type: "vpc",
      name,
      parentId: regionNode.id,
      accountId: acct.id,
      region: regionName,
      tags: tagsFor(acct, { Name: name }),
      meta: { vpcId, cidr: `${base}.0/20` },
    });

    const subnets: Record<Tier, GraphNode[]> = { public: [], private: [], data: [] };
    const [, octet2, octet3] = base.split(".").map(Number);
    let slot = 0;
    for (const tier of tiers) {
      for (let a = 0; a < azCount; a++) {
        const az = `${regionName}${"abc"[a]}`;
        const subnetId = `subnet-${rng.hex(17)}`;
        const subnetName = `${name}-${tier}-${"abc"[a]}`;
        subnets[tier].push(
          add({
            id: arn("ec2", acct, regionName, `subnet/${subnetId}`),
            type: "subnet",
            name: subnetName,
            parentId: vpc.id,
            accountId: acct.id,
            region: regionName,
            az,
            tags: tagsFor(acct, { Name: subnetName, Tier: tier }),
            meta: { subnetId, cidr: `10.${octet2}.${octet3 + slot++}.0/24`, tier },
          }),
        );
      }
    }

    let igw: GraphNode | undefined;
    if (subnets.public.length) {
      const igwId = `igw-${rng.hex(17)}`;
      igw = add({
        id: arn("ec2", acct, regionName, `internet-gateway/${igwId}`),
        type: "igw",
        name: `${name}-igw`,
        parentId: vpc.id,
        accountId: acct.id,
        region: regionName,
        meta: { igwId },
      });
      for (const subnet of subnets.public) link("routes", subnet, igw);
    }
    return { vpc, subnets, igw };
  };

  const natGateway = (acct: Account, subnet: GraphNode): GraphNode => {
    const natId = `nat-${rng.hex(17)}`;
    return add({
      id: arn("ec2", acct, subnet.region!, `natgateway/${natId}`),
      type: "nat-gateway",
      name: `${subnet.name}-nat`,
      parentId: subnet.id,
      accountId: acct.id,
      region: subnet.region,
      status: health(),
      meta: { natId },
    });
  };

  const ipIn = (subnet: GraphNode): string => {
    const prefix = String(subnet.meta.cidr).split(".").slice(0, 3).join(".");
    return `${prefix}.${rng.int(4, 250)}`;
  };

  const instance = (acct: Account, subnet: GraphNode, name: string, types: string[], stoppedChance = 0): GraphNode => {
    const instanceId = `i-${rng.hex(17)}`;
    return add({
      id: arn("ec2", acct, subnet.region!, `instance/${instanceId}`),
      type: "ec2",
      name,
      parentId: subnet.id,
      accountId: acct.id,
      region: subnet.region,
      status: health(stoppedChance),
      tags: tagsFor(acct, { Name: name }),
      meta: { instanceId, instanceType: rng.pick(types), privateIp: ipIn(subnet), az: subnet.az! },
    });
  };

  const bucket = (acct: Account, regionName: string, name: string): GraphNode => {
    const bucketName = `${name}-${acct.id}`;
    return add({
      id: `arn:aws:s3:::${bucketName}`,
      type: "s3",
      name: bucketName,
      parentId: region(acct, regionName).id,
      accountId: acct.id,
      region: regionName,
      status: health(),
      tags: tagsFor(acct),
      meta: { versioning: rng.chance(0.8), objects: rng.int(10, 5_000_000) },
    });
  };

  const regional = (
    acct: Account,
    regionName: string,
    type: "sqs" | "dynamodb" | "lambda",
    name: string,
    parent: GraphNode = region(acct, regionName),
  ): GraphNode => {
    let resource: string;
    let meta: GraphNode["meta"];
    switch (type) {
      case "sqs":
        resource = name;
        meta = { visibleMessages: rng.int(0, 2_000) };
        break;
      case "dynamodb":
        resource = `table/${name}`;
        meta = { billingMode: rng.chance(0.7) ? "PAY_PER_REQUEST" : "PROVISIONED", items: rng.int(1_000, 80_000_000) };
        break;
      case "lambda":
        resource = `function:${name}`;
        meta = { runtime: rng.pick(["nodejs22.x", "python3.13", "java21"]), memoryMb: rng.pick([256, 512, 1024]) };
        break;
    }
    return add({
      id: arn(type, acct, regionName, resource),
      type,
      name,
      parentId: parent.id,
      accountId: acct.id,
      region: regionName,
      status: health(),
      tags: tagsFor(acct),
      meta,
    });
  };

  // ── Management account (no workloads, per best practice) ──────────────────

  const mgmt = account("management", "shared", org, mgmtId);
  bucket(mgmt, PRIMARY_REGION, "org-billing-reports");

  // ── Security OU ───────────────────────────────────────────────────────────

  const securityOu = ou("Security", org);
  const logArchive = account("log-archive", "shared", securityOu);
  for (const name of ["org-cloudtrail", "org-config-history", "vpc-flow-logs"]) bucket(logArchive, PRIMARY_REGION, name);

  const audit = account("audit", "shared", securityOu);
  const findings = regional(audit, PRIMARY_REGION, "sqs", "guardduty-findings");
  const responder = regional(audit, PRIMARY_REGION, "lambda", "guardduty-responder");
  const findingsTable = regional(audit, PRIMARY_REGION, "dynamodb", "security-findings");
  link("invokes", findings, responder);
  link("connects", responder, findingsTable);

  // ── Infrastructure OU: hub networking + shared services ───────────────────

  const infraOu = ou("Infrastructure", org);
  const sharedNetwork = account("shared-network", "shared", infraOu);
  const transitGateways = new Map<string, GraphNode>();
  for (const regionName of [PRIMARY_REGION, DR_REGION]) {
    const tgwId = `tgw-${rng.hex(17)}`;
    const tgw = add({
      id: arn("ec2", sharedNetwork, regionName, `transit-gateway/${tgwId}`),
      type: "tgw",
      name: `tgw-${regionName}`,
      parentId: region(sharedNetwork, regionName).id,
      accountId: sharedNetwork.id,
      region: regionName,
      meta: { tgwId, amazonSideAsn: 64512 + transitGateways.size, sharedViaRam: true },
    });
    transitGateways.set(regionName, tgw);

    // Centralized egress: workload VPCs reach the internet through this VPC's NAT gateways.
    const egress = network(sharedNetwork, regionName, `egress-${regionName}`, 2, ["public", "private"]);
    link("tgw-attachment", egress.vpc, tgw);
    egress.subnets.public.forEach((pub, i) => {
      const nat = natGateway(sharedNetwork, pub);
      link("routes", egress.subnets.private[i], nat);
    });
  }

  const sharedServices = account("shared-services", "shared", infraOu);
  {
    const net = network(sharedServices, PRIMARY_REGION, "shared-services", 2, ["private"]);
    link("tgw-attachment", net.vpc, transitGateways.get(PRIMARY_REGION)!);
    for (const subnet of net.subnets.private) link("routes", subnet, transitGateways.get(PRIMARY_REGION)!);
    add({
      id: arn("eks", sharedServices, PRIMARY_REGION, "cluster/platform"),
      type: "eks-cluster",
      name: "platform",
      parentId: net.vpc.id,
      accountId: sharedServices.id,
      region: PRIMARY_REGION,
      status: health(),
      meta: { version: "1.34", nodes: rng.int(6, 24) },
    });
    for (let i = 0; i < 3; i++) {
      instance(sharedServices, net.subnets.private[i % 2], `ci-runner-${i + 1}`, ["c6i.2xlarge"], 0.2);
    }
    bucket(sharedServices, PRIMARY_REGION, "build-artifacts");
  }

  // ── Workloads OU: prod / staging / dev per team ───────────────────────────

  const workloadsOu = ou("Workloads", org);
  const prodOu = ou("Prod", workloadsOu);
  const nonProdOu = ou("NonProd", workloadsOu);
  const prodVpcs: GraphNode[] = [];

  const buildWorkload = (acct: Account, team: string) => {
    const isProd = acct.env === "prod";
    const regions = isProd && rng.chance(0.5) ? [PRIMARY_REGION, DR_REGION] : [PRIMARY_REGION];

    for (const regionName of regions) {
      const name = `${team}-${acct.env}`;
      const net = network(acct, regionName, name, isProd ? 3 : 2, ["public", "private", "data"]);
      const tgw = transitGateways.get(regionName)!;
      link("tgw-attachment", net.vpc, tgw);
      for (const subnet of net.subnets.private) link("routes", subnet, tgw);
      if (isProd && regionName === PRIMARY_REGION) prodVpcs.push(net.vpc);

      const alb = add({
        id: arn("elasticloadbalancing", acct, regionName, `loadbalancer/app/${name}-alb/${rng.hex(16)}`),
        type: "elb",
        name: `${name}-alb`,
        parentId: net.vpc.id,
        accountId: acct.id,
        region: regionName,
        status: health(),
        tags: tagsFor(acct),
        meta: { scheme: "internet-facing", type: "application", subnets: net.subnets.public.length },
      });

      const apps: GraphNode[] = [];
      if (rng.chance(0.5)) {
        const cluster = `${name}-cluster`;
        for (let i = 0, n = rng.int(1, 3); i < n; i++) {
          const service = `${team}-${["api", "web", "worker"][i]}`;
          apps.push(
            add({
              id: arn("ecs", acct, regionName, `service/${cluster}/${service}`),
              type: "ecs-service",
              name: service,
              parentId: net.vpc.id,
              accountId: acct.id,
              region: regionName,
              status: health(),
              tags: tagsFor(acct),
              meta: { cluster, launchType: "FARGATE", desiredCount: isProd ? rng.int(3, 12) : rng.int(1, 2) },
            }),
          );
        }
      } else {
        const types = isProd ? ["m6i.large", "m6i.xlarge", "c6i.xlarge"] : ["t3.medium", "t3.large"];
        for (let i = 0, n = isProd ? rng.int(3, 6) : rng.int(1, 3); i < n; i++) {
          const subnet = net.subnets.private[i % net.subnets.private.length];
          apps.push(instance(acct, subnet, `${team}-app-${i + 1}`, types, acct.env === "dev" ? 0.15 : 0));
        }
      }
      for (const app of apps) link("targets", alb, app);

      const engine = rng.pick(["aurora-postgresql", "postgres", "mysql"]);
      const db = add({
        id: arn("rds", acct, regionName, `db:${name}-db`),
        type: "rds",
        name: `${name}-db`,
        parentId: net.subnets.data[0].id,
        accountId: acct.id,
        region: regionName,
        status: health(),
        tags: tagsFor(acct),
        meta: { engine, instanceClass: isProd ? "db.r6g.xlarge" : "db.t4g.medium", role: "primary", multiAz: isProd },
      });
      if (isProd) {
        const replica = add({
          id: arn("rds", acct, regionName, `db:${name}-db-replica`),
          type: "rds",
          name: `${name}-db-replica`,
          parentId: net.subnets.data[1].id,
          accountId: acct.id,
          region: regionName,
          status: health(),
          tags: tagsFor(acct),
          meta: { engine, instanceClass: "db.r6g.xlarge", role: "replica" },
        });
        link("connects", db, replica);
      }
      for (const app of apps) link("connects", app, db);

      const queue = regional(acct, regionName, "sqs", `${name}-events`);
      const worker = regional(acct, regionName, "lambda", `${name}-event-worker`, net.subnets.private[0]);
      const table = regional(acct, regionName, "dynamodb", `${name}-state`);
      link("invokes", queue, worker);
      link("connects", worker, table);

      // Most prod and staging workloads keep a cache next to the database.
      if (acct.env !== "dev" && rng.chance(0.7)) {
        const cache = add({
          id: arn("elasticache", acct, regionName, `replicationgroup:${name}-cache`),
          type: "elasticache",
          name: `${name}-cache`,
          parentId: net.subnets.data[0].id,
          accountId: acct.id,
          region: regionName,
          status: health(),
          tags: tagsFor(acct),
          meta: { engine: rng.pick(["valkey", "redis"]), nodeType: isProd ? "cache.r7g.large" : "cache.t4g.small", members: isProd ? 3 : 1, multiAz: isProd },
        });
        for (const app of apps) link("connects", app, cache);
      }

      // Some teams also expose an HTTP API backed by a function.
      if (rng.chance(0.5)) {
        const api = add({
          id: `arn:aws:apigateway:${regionName}::/apis/${rng.hex(10)}`,
          type: "api-gateway",
          name: `${name}-api`,
          parentId: region(acct, regionName).id,
          accountId: acct.id,
          region: regionName,
          status: health(),
          tags: tagsFor(acct),
          meta: { protocol: "HTTP", endpointType: "REGIONAL" },
        });
        const handler = regional(acct, regionName, "lambda", `${name}-api-handler`);
        link("invokes", api, handler);
        link("connects", handler, table);
      }

      if (regionName === PRIMARY_REGION) {
        const assets = bucket(acct, regionName, `${name}-assets`);
        for (const app of apps) link("connects", app, assets);
        // Prod is served through CloudFront (a global service, shown in us-east-1).
        if (isProd) {
          const cdn = add({
            id: `arn:aws:cloudfront::${acct.id}:distribution/E${rng.hex(13).toUpperCase()}`,
            type: "cloudfront",
            name: `${team}.example.com`,
            parentId: region(acct, PRIMARY_REGION).id,
            accountId: acct.id,
            region: PRIMARY_REGION,
            status: health(),
            tags: tagsFor(acct),
            meta: { domainName: `d${rng.hex(13)}.cloudfront.net`, aliases: `${team}.example.com`, priceClass: "PriceClass_100", enabled: true },
          });
          link("targets", cdn, alb);
          link("targets", cdn, assets);
        }
      }
    }
  };

  for (let t = 0; t < teams; t++) {
    const lap = Math.floor(t / TEAM_NAMES.length);
    const team = TEAM_NAMES[t % TEAM_NAMES.length] + (lap ? `-${lap + 1}` : "");
    buildWorkload(account(`${team}-prod`, "prod", prodOu), team);
    buildWorkload(account(`${team}-staging`, "staging", nonProdOu), team);
    buildWorkload(account(`${team}-dev`, "dev", nonProdOu), team);
  }

  // A couple of direct peerings between prod VPCs (e.g. analytics pulling from other teams).
  for (let i = 0; i < Math.min(2, prodVpcs.length - 1); i++) {
    const a = prodVpcs[i];
    const b = prodVpcs[rng.int(i + 1, prodVpcs.length - 1)];
    link("peering", a, b);
  }

  // ── Sandbox OU: self-contained VPCs, lots of stopped instances ────────────

  const sandboxOu = ou("Sandbox", org);
  for (let s = 0; s < sandboxes; s++) {
    const acct = account(`sandbox-${s + 1}`, "sandbox", sandboxOu);
    const regionName = rng.pick(SANDBOX_REGIONS);
    const net = network(acct, regionName, `sandbox-${s + 1}`, 2, ["public", "private"]);
    const nat = natGateway(acct, net.subnets.public[0]);
    for (const subnet of net.subnets.private) link("routes", subnet, nat);
    for (let i = 0, n = rng.int(1, 4); i < n; i++) {
      instance(acct, rng.pick(net.subnets.private), `experiment-${i + 1}`, ["t3.micro", "t3.small", "g5.xlarge"], 0.3);
    }
    bucket(acct, regionName, `sandbox-${s + 1}-scratch`);
  }

  // ── Suspended OU: closed account awaiting removal ─────────────────────────

  const suspendedOu = ou("Suspended", org);
  const closed = account("legacy-reporting", "prod", suspendedOu);
  closed.node.status = "stopped";
  closed.node.meta.accountStatus = "SUSPENDED";

  // ── Site-to-Site VPN: offices on the hub transit gateways, a partner on a prod VPC ──
  // Added last, with their own RNG, so the rest of the graph (and its costs) is the same as without them.

  const vpnRng = new Rng(seed ^ 0x7e1);
  /** `owner`: the gateway's node, or the VPC of a virtual private gateway (account, region, environment tag). */
  const vpnConnection = (owner: GraphNode, gateway: GraphNode, site: string, routing: "bgp" | "static", tunnelsUp = 2) => {
    const regionName = owner.region!;
    const vpnId = `vpn-${vpnRng.hex(17)}`;
    const vpn = add({
      id: `arn:aws:ec2:${regionName}:${owner.accountId}:vpn-connection/${vpnId}`,
      type: "vpn-connection",
      name: site,
      parentId: `region/${owner.accountId}/${regionName}`,
      accountId: owner.accountId,
      region: regionName,
      status: tunnelsUp === 0 ? "critical" : tunnelsUp < 2 ? "warning" : "ok",
      tags: { Environment: owner.tags.Environment ?? "shared", Name: site },
      meta: {
        vpnId,
        state: "available",
        tunnels: 2,
        tunnelsUp,
        routing,
        ...(routing === "static" ? { staticRoutes: `192.168.${vpnRng.int(0, 255)}.0/24` } : {}),
        customerGatewayId: `cgw-${vpnRng.hex(17)}`,
        customerGateway: `${site}-router`,
        customerGatewayIp: `198.51.100.${vpnRng.int(1, 254)}`,
        customerGatewayAsn: String(65000 + vpnRng.int(0, 500)),
      },
    });
    link("vpn", vpn, gateway);
  };
  const primaryTgw = transitGateways.get(PRIMARY_REGION)!;
  vpnConnection(primaryTgw, primaryTgw, "hq-office", "bgp");
  vpnConnection(primaryTgw, primaryTgw, "branch-lisbon", "static", 1);
  const drTgw = transitGateways.get(DR_REGION)!;
  vpnConnection(drTgw, drTgw, "dr-datacenter", "bgp");

  const partnerVpc = prodVpcs[0];
  if (partnerVpc) {
    const vgwId = `vgw-${vpnRng.hex(17)}`;
    const vgw = add({
      id: `arn:aws:ec2:${partnerVpc.region}:${partnerVpc.accountId}:vpn-gateway/${vgwId}`,
      type: "vpn-gateway",
      name: `${partnerVpc.name}-vgw`,
      parentId: partnerVpc.id,
      accountId: partnerVpc.accountId,
      region: partnerVpc.region,
      tags: { ...partnerVpc.tags, Name: `${partnerVpc.name}-vgw` },
      meta: { vgwId, amazonSideAsn: 64600, state: "available", attached: true },
    });
    for (const subnet of nodes.filter((n) => n.parentId === partnerVpc.id && n.meta.tier === "private")) link("routes", subnet, vgw);
    vpnConnection(partnerVpc, vgw, "partner-acme", "static");
  }

  // ── Inspection and end-user computing: a firewall in the primary egress VPC, WorkSpaces in shared services ──
  // Same approach: own RNG, appended last.

  const eucRng = new Rng(seed ^ 0xf1e);
  const egressVpc = nodes.find((n) => n.type === "vpc" && n.name === `egress-${PRIMARY_REGION}`);
  if (egressVpc) {
    const subnets = nodes.filter((n) => n.parentId === egressVpc.id && n.type === "subnet");
    const firewallName = "egress-inspection";
    const firewall = add({
      id: `arn:aws:network-firewall:${PRIMARY_REGION}:${egressVpc.accountId}:firewall/${firewallName}`,
      type: "network-firewall",
      name: firewallName,
      parentId: egressVpc.id,
      accountId: egressVpc.accountId,
      region: PRIMARY_REGION,
      tags: { ...egressVpc.tags, Name: firewallName },
      meta: {
        policy: "egress-allow-list",
        endpoints: 2,
        zones: subnets.filter((n) => n.meta.tier === "private").map((n) => n.az).join(", "),
        state: "READY",
        configSync: "IN_SYNC",
        deleteProtection: true,
      },
    });
    for (const subnet of subnets.filter((n) => n.meta.tier === "private")) link("routes", subnet, firewall);
  }

  const servicesVpc = nodes.find((n) => n.type === "vpc" && n.name === "shared-services");
  if (servicesVpc) {
    const directoryId = `d-${eucRng.hex(10)}`;
    const total = eucRng.int(30, 80);
    const unhealthy = 1;
    const stopped = eucRng.int(3, 12);
    add({
      id: `arn:aws:workspaces:${PRIMARY_REGION}:${servicesVpc.accountId}:directoryid/${directoryId}`,
      type: "workspaces",
      name: "corp-desktops",
      parentId: servicesVpc.id,
      accountId: servicesVpc.accountId,
      region: PRIMARY_REGION,
      status: "warning",
      tags: { Environment: "shared" },
      meta: {
        directoryId,
        directoryName: "corp.example.com",
        directoryType: "AD_CONNECTOR",
        workspaceType: "PERSONAL",
        state: "REGISTERED",
        workspaces: total,
        available: total - stopped - unhealthy,
        stopped,
        unhealthy,
        runningModes: `AUTO_STOP ${total - 6}, ALWAYS_ON 6`,
        computeTypes: `STANDARD ${total - 4}, PERFORMANCE 4`,
      },
    });
  }

  if (costs) addCosts(nodes, new Rng(seed ^ 0x5eed), generatedAt);
  return { version: 1, source: "mock", generatedAt, nodes, edges };
}

/** Rough monthly list prices and the Cost Explorer service each resource type bills under. */
const MONTHLY: Partial<Record<NodeType, [service: string, usd: number]>> = {
  ec2: ["Amazon Elastic Compute Cloud - Compute", 70],
  "nat-gateway": ["EC2 - Other", 45],
  elb: ["Amazon Elastic Load Balancing", 25],
  "ecs-service": ["Amazon Elastic Container Service", 18],
  "eks-cluster": ["Amazon Elastic Container Service for Kubernetes", 73],
  lambda: ["AWS Lambda", 4],
  rds: ["Amazon Relational Database Service", 260],
  elasticache: ["Amazon ElastiCache", 95],
  dynamodb: ["Amazon DynamoDB", 22],
  s3: ["Amazon Simple Storage Service", 12],
  sqs: ["Amazon Simple Queue Service", 1.5],
  tgw: ["Amazon Virtual Private Cloud", 36],
  "vpn-connection": ["Amazon Virtual Private Cloud", 36],
  "network-firewall": ["AWS Network Firewall", 580],
  workspaces: ["Amazon WorkSpaces", 1900],
  "api-gateway": ["Amazon API Gateway", 15],
  cloudfront: ["Amazon CloudFront", 40],
};
const GLOBAL_SERVICES = new Set(["Amazon CloudFront"]);

/** Last month and month to date per region and account, totals on the root; a separate RNG keeps the rest stable. */
function addCosts(nodes: GraphNode[], rng: Rng, generatedAt: string): void {
  const now = new Date(generatedAt);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = (now.getUTCDate() - 1) / daysInMonth;
  const day = (d: Date) => d.toISOString().slice(0, 10);

  const byAccount = new Map<string, { regions: Map<string, [number, number]>; services: Map<string, number> }>();
  for (const node of nodes) {
    const price = MONTHLY[node.type];
    if (!price || !node.accountId) continue;
    const [service, usd] = price;
    // Stopped resources still pay for storage; prod runs bigger and busier.
    const scale = (node.status === "stopped" ? 0.1 : 1) * (node.tags.Environment === "prod" ? 2.5 : 1) * (0.6 + rng.next());
    const last = usd * scale;
    const toDate = last * elapsed * (0.85 + 0.3 * rng.next());
    const account = byAccount.get(node.accountId) ?? { regions: new Map(), services: new Map() };
    byAccount.set(node.accountId, account);
    const region = GLOBAL_SERVICES.has(service) ? "global" : (node.region ?? "global");
    const entry = account.regions.get(region) ?? [0, 0];
    account.regions.set(region, [entry[0] + last, entry[1] + toDate]);
    account.services.set(service, (account.services.get(service) ?? 0) + toDate);
  }

  const total = [0, 0];
  let accounts = 0;
  for (const node of nodes) {
    if (node.type === "region" && node.accountId) {
      const [last, toDate] = byAccount.get(node.accountId)?.regions.get(node.name) ?? [0, 0];
      node.meta.costLastMonth = cents(last);
      node.meta.costMonthToDate = cents(toDate);
    }
    if (node.type !== "account" || !node.accountId) continue;
    const account = byAccount.get(node.accountId);
    const sums = [...(account?.regions.values() ?? [])].reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
    node.meta.costLastMonth = cents(sums[0]);
    node.meta.costMonthToDate = cents(sums[1]);
    const top = formatTopServices(account?.services ?? []);
    if (top) node.meta.costTopServices = top;
    total[0] += sums[0];
    total[1] += sums[1];
    accounts++;
  }

  const root = nodes.find((n) => !n.parentId)!;
  Object.assign(root.meta, {
    costLastMonth: cents(total[0]),
    costMonthToDate: cents(total[1]),
    costCurrency: "USD",
    costMetric: "UnblendedCost",
    costFrom: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
    costThrough: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))),
    costAccounts: accounts,
  });
}

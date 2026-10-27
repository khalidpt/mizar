import { DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import type { MizarConfig } from "@/lib/config";
import type { GraphNode, InfraGraph } from "@/lib/graph/types";
import type { CollectContext, Collector } from "../index";
import {
  aggregatorCoverage,
  type ConfigItem,
  enrichmentNeeds,
  groupItems,
  mapConfigDeferred,
  mapConfigRegion,
  queryAggregator,
  type RegionItems,
} from "./aggregator";
import { GraphBuilder } from "./builder";
import { applyCosts, queryCosts } from "./cost";
import type { AccountContext } from "./map";
import { resolveScope, type Target } from "./org";
import {
  collectBuckets,
  collectDistributions,
  collectRegion,
  fetchApis,
  fetchCaches,
  fetchEcsServices,
  fetchEventSourceMappings,
  fetchFiringAlarms,
  fetchFirewalls,
  fetchLoadBalancerTargets,
  fetchVpnConnections,
  fetchWorkspaces,
} from "./regional";
import { SecurityGroups } from "./security";
import {
  type Caller,
  canAuthenticate,
  cloudFrontClient,
  cloudFrontRegion,
  configClient,
  costCredentials,
  costExplorerClient,
  costExplorerRegion,
  costRoleArn,
  type Credentials,
  credentialsFor,
  destroyClients,
  ec2Client,
  homeRegion,
  iamClient,
  organizationsClient,
  regionClients,
  roleArn,
  s3Client,
  whoAmI,
} from "./session";
import { describeError, pool } from "./util";

type Log = (message: string) => void;

/** One account's collection state: its mapping context, credentials and the warnings gathered on the way. */
interface AccountRun {
  ctx: AccountContext;
  target: Target;
  credentials: Credentials;
  warnings: { service: string; region: string; message: string }[];
  label: string;
  started: number;
}

/**
 * Reads the account scope (Organizations tree, an explicit list, or the caller's account), then the inventory:
 *
 * - `direct`: assumes the read-only role in each account and lists resources region by region with service APIs.
 * - `config`: one AWS Config aggregator query in the collecting account, optionally enriched with targeted direct
 *   calls (only where Config found something it can't describe fully) through the same read-only role.
 *
 * Per-service failures become warnings on the account node, never a failed run; an account that can't be entered
 * at all is marked `warning` with the reason in `meta.collectError`.
 */
export class AwsCollector implements Collector {
  readonly name = "aws";

  constructor(private readonly config: MizarConfig["aws"]) {}

  async collect({ log }: CollectContext): Promise<InfraGraph> {
    const config = this.config;
    const home = await homeRegion(config);
    const caller = await whoAmI(home);
    log(`authenticated as ${caller.arn}`);

    const org = organizationsClient(home);
    const scope = await resolveScope(config, caller, org, log).finally(() => org.destroy());
    log(`scope: ${scope.description}; collecting ${scope.targets.length} active account(s)`);

    const b = new GraphBuilder();
    for (const node of scope.nodes) b.add(node);
    const security = new SecurityGroups();
    const start = (target: Target) => this.startAccount(b, security, caller, home, target);
    // Independent of the inventory (its annotations apply at build time), so it runs alongside.
    const root = scope.nodes.find((n) => !n.parentId)!;
    const costs = config.cost.enabled ? this.collectCosts(b, caller, root, scope.targets, log) : undefined;

    if (config.inventory === "config") {
      await this.collectFromConfig(scope.targets, start, home, log);
    } else {
      await pool(config.concurrency.accounts, scope.targets, (target) => this.collectDirect(start(target), caller, home, log));
    }
    await costs;

    security.apply(b);
    const { nodes, edges } = b.build({ includeEmptyDefaultVpcs: config.includeEmptyDefaultVpcs });
    return { version: 1, source: "aws", generatedAt: new Date().toISOString(), nodes, edges };
  }

  private startAccount(b: GraphBuilder, security: SecurityGroups, caller: Caller, home: string, target: Target): AccountRun {
    const warnings: AccountRun["warnings"] = [];
    const ctx: AccountContext = {
      b,
      accountId: target.accountId,
      nodeId: target.nodeId,
      partition: caller.partition,
      security,
      attempt: async (service, region, fn) => {
        try {
          return await fn();
        } catch (error) {
          warnings.push({ service, region, message: describeError(error) });
          return undefined;
        }
      },
    };
    const label = target.name === target.accountId ? target.accountId : `${target.name} (${target.accountId})`;
    return { ctx, target, credentials: credentialsFor(this.config, caller, target.accountId, home), warnings, label, started: Date.now() };
  }

  /** Marks an account that can't be entered; nothing else is collected from it. */
  private unreachable(run: AccountRun, caller: Caller, reason: string, log: Log): void {
    const via = run.credentials ? ` via ${roleArn(this.config, caller, run.target.accountId)}` : "";
    log(`${run.label}: skipped, cannot read the account${via}: ${reason}`);
    run.ctx.b.update(run.target.nodeId, (node) => {
      node.status = "warning";
      node.meta.collectError = `Cannot read account${via}: ${reason}`;
    });
  }

  /** Outside an Organization the account has no name; its IAM alias is the closest thing. */
  private async nameFromAlias(run: AccountRun, home: string): Promise<void> {
    if (run.target.name !== run.target.accountId) return;
    const iam = iamClient(home, run.credentials);
    const alias = await run.ctx
      .attempt("iam", "global", async () => (await iam.send(new ListAccountAliasesCommand({}))).AccountAliases?.[0])
      .finally(() => iam.destroy());
    if (!alias) return;
    run.ctx.b.update(run.target.nodeId, (node) => (node.name = alias));
    run.label = `${alias} (${run.target.accountId})`;
  }

  private finishAccount(run: AccountRun, log: Log, summary = ""): void {
    const { warnings, label } = run;
    if (warnings.length) {
      const grouped = groupWarnings(warnings);
      run.ctx.b.update(run.target.nodeId, (node) => {
        node.meta.collectWarnings = warnings.length;
        node.meta.collectWarning = grouped[0];
      });
      for (const line of grouped.slice(0, 8)) log(`${label}: ${line}`);
      if (grouped.length > 8) log(`${label}: … and ${grouped.length - 8} more kinds of warning`);
    }
    const seconds = ((Date.now() - run.started) / 1000).toFixed(1);
    log(`${label}: ${summary} in ${seconds} s${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
  }

  // ── Direct inventory ───────────────────────────────────────────────────────

  private async collectDirect(run: AccountRun, caller: Caller, home: string, log: Log): Promise<void> {
    const { ctx, credentials } = run;
    // Listing enabled regions doubles as the access check: it fails fast when the role can't be assumed.
    let regions: string[];
    const ec2 = ec2Client(home, credentials);
    try {
      const { Regions = [] } = await ec2.send(new DescribeRegionsCommand({}));
      const enabled = Regions.flatMap((r) => (r.RegionName ? [r.RegionName] : [])).sort();
      regions = this.config.regions.length ? this.config.regions.filter((r) => enabled.includes(r)) : enabled;
    } catch (error) {
      return this.unreachable(run, caller, describeError(error), log);
    } finally {
      ec2.destroy();
    }

    await this.nameFromAlias(run, home);
    const s3 = s3Client(home, credentials);
    await collectBuckets(ctx, s3, home, new Set(regions)).finally(() => s3.destroy());
    // Global like S3, and kept whatever `aws.regions` says: distributions front resources in every region.
    const cloudFrontHome = cloudFrontRegion(ctx.partition);
    if (cloudFrontHome) {
      const cloudfront = cloudFrontClient(cloudFrontHome, credentials);
      await collectDistributions(ctx, cloudfront, cloudFrontHome).finally(() => cloudfront.destroy());
    }
    await pool(this.config.concurrency.regions, regions, async (region) => {
      const clients = regionClients(region, credentials);
      try {
        await collectRegion(ctx, region, clients);
      } finally {
        destroyClients(clients);
      }
    });
    this.finishAccount(run, log, `${regions.length} region(s)`);
  }

  // ── AWS Config inventory ───────────────────────────────────────────────────

  private async collectFromConfig(targets: Target[], start: (t: Target) => AccountRun, home: string, log: Log): Promise<void> {
    const config = this.config;
    const aggregator = config.configAggregator;
    if (!aggregator) throw new Error('aws.inventory is "config" but aws.configAggregator is not set');
    const region = config.configAggregatorRegion ?? home;

    const client = configClient(region);
    let items: ConfigItem[];
    let coverage: Map<string, string | undefined> | undefined;
    try {
      [items, coverage] = await Promise.all([
        queryAggregator(client, aggregator),
        // Optional: without it, accounts the aggregator doesn't cover just look empty.
        aggregatorCoverage(client, aggregator).catch((error) => {
          log(`aggregator coverage unavailable (${describeError(error)})`);
          return undefined;
        }),
      ]);
    } catch (error) {
      throw new Error(`Could not query AWS Config aggregator "${aggregator}" in ${region}: ${describeError(error)}`);
    } finally {
      client.destroy();
    }
    log(`aggregator ${aggregator} (${region}): ${items.length} resource(s)`);

    const accounts = new Set(targets.map((t) => t.accountId));
    const grouped = groupItems(items, accounts, config.regions.length ? new Set(config.regions) : undefined);
    await pool(config.concurrency.accounts, targets, async (target) => {
      const run = start(target);
      const regions = [...(grouped.get(target.accountId)?.values() ?? [])];

      if (coverage && !coverage.has(target.accountId)) {
        run.ctx.b.update(target.nodeId, (node) => {
          node.status = "warning";
          node.meta.collectError = `Not covered by AWS Config aggregator ${aggregator}`;
        });
        log(`${run.label}: not covered by aggregator ${aggregator}`);
      } else if (coverage?.get(target.accountId)) {
        run.warnings.push({ service: "config", region: "aggregator", message: `source failing in ${coverage.get(target.accountId)}` });
      }

      for (const items of regions) mapConfigRegion(run.ctx, items);
      await this.enrich(run, regions, home, log);
      const resources = regions.reduce((n, r) => n + [...r.byType.values()].reduce((m, list) => m + list.length, 0), 0);
      this.finishAccount(run, log, `${resources} Config item(s) in ${regions.length} region(s)`);
    });
  }

  /** Fills in what Config doesn't record, with direct calls only in regions where they can find something. */
  private async enrich(run: AccountRun, regions: RegionItems[], home: string, log: Log): Promise<void> {
    const work = regions.map((items) => ({ items, needs: enrichmentNeeds(items) }));
    const wanted = this.config.enrich && work.some(({ needs }) => Object.values(needs).some(Boolean));
    const problem = wanted ? await canAuthenticate(run.credentials, home) : undefined;
    if (problem) {
      log(`${run.label}: enrichment skipped, cannot assume the read-only role: ${problem}`);
      run.warnings.push({ service: "enrichment", region: "all regions", message: problem });
    }
    if (!wanted || problem) {
      for (const { items } of work) mapConfigDeferred(run.ctx, items, new Map());
      return;
    }

    await this.nameFromAlias(run, home);
    await pool(this.config.concurrency.regions, work, async ({ items, needs }) => {
      if (!Object.values(needs).some(Boolean)) return mapConfigDeferred(run.ctx, items, new Map());
      const clients = regionClients(items.region, run.credentials);
      try {
        const targetGroups = (needs.targets && (await fetchLoadBalancerTargets(run.ctx, items.region, clients))) || new Map<string, string[]>();
        await Promise.all([
          needs.ecs && fetchEcsServices(run.ctx, items.region, clients, targetGroups),
          needs.eventSources && fetchEventSourceMappings(run.ctx, items.region, clients),
          needs.alarms && fetchFiringAlarms(run.ctx, items.region, clients),
          needs.apis && fetchApis(run.ctx, items.region, clients),
          needs.caches && fetchCaches(run.ctx, items.region, clients),
          needs.vpn && fetchVpnConnections(run.ctx, items.region, clients),
          needs.firewalls && fetchFirewalls(run.ctx, items.region, clients),
          needs.workspaces && fetchWorkspaces(run.ctx, items.region, clients),
        ]);
        // Config's deferred records only fill in what the direct listing didn't add (first write wins).
        mapConfigDeferred(run.ctx, items, targetGroups);
      } finally {
        destroyClients(clients);
      }
    });
  }

  // ── Cost Explorer ──────────────────────────────────────────────────────────

  /** Never fails the run: a problem is logged and recorded on the organization root (`meta.costError`). */
  private async collectCosts(b: GraphBuilder, caller: Caller, root: GraphNode, targets: Target[], log: Log): Promise<void> {
    const config = this.config;
    const accountId = config.cost.accountId ?? (String(root.meta.managementAccountId ?? "") || caller.accountId);
    const via = accountId === caller.accountId ? "" : ` via ${costRoleArn(config, caller, accountId)}`;
    const fail = (reason: string) => {
      log(`costs: ${reason}`);
      b.update(root.id, (node) => {
        if (node.status === "ok") node.status = "warning";
        node.meta.costError = reason;
      });
    };

    const region = costExplorerRegion(caller.partition);
    if (!region) return fail(`Cost Explorer is not available in partition ${caller.partition}`);
    const client = costExplorerClient(region, costCredentials(config, caller, accountId, region));
    try {
      const report = await queryCosts(client, config.cost.metric);
      applyCosts(b, report, targets, root, accountId);
      log(
        `costs: ${report.metric} ${report.from} to ${report.through} from account ${accountId}${via}; ` +
          `${report.requests} Cost Explorer request(s), billed by AWS at $0.01 each`,
      );
    } catch (error) {
      fail(`Cannot read costs from account ${accountId}${via}: ${describeError(error)}`);
    } finally {
      client.destroy();
    }
  }
}

/**
 * One line per service and error kind, so a missing permission reads once ("cloudwatch in 17 regions: AccessDenied …")
 * instead of once per region.
 */
export function groupWarnings(warnings: readonly { service: string; region: string; message: string }[]): string[] {
  const groups = new Map<string, { service: string; regions: string[]; message: string }>();
  for (const w of warnings) {
    const key = `${w.service}|${w.message.split(":")[0]}`;
    const group = groups.get(key);
    if (group) group.regions.push(w.region);
    else groups.set(key, { service: w.service, regions: [w.region], message: w.message });
  }
  return [...groups.values()].map(({ service, regions, message }) => {
    const where = regions.length === 1 ? regions[0] : `${regions.length} regions`;
    return `${service} in ${where}: ${message}`;
  });
}

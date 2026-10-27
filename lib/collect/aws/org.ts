import {
  DescribeOrganizationCommand,
  type OrganizationsClient,
  paginateListAccountsForParent,
  paginateListOrganizationalUnitsForParent,
  paginateListRoots,
  paginateListTagsForResource,
} from "@aws-sdk/client-organizations";
import type { MizarConfig } from "@/lib/config";
import type { GraphNode, NodeStatus } from "@/lib/graph/types";
import type { Caller } from "./session";
import { all, describeError, inferEnvironment, pool, tagRecord } from "./util";

export interface OrgAccount {
  id: string;
  name: string;
  /** Organizations ARN; absent when the account was not read from an Organization. */
  arn?: string;
  email?: string;
  /** ACTIVE, SUSPENDED, PENDING_CLOSURE, CLOSED; `ACTIVE` when unknown. */
  state: string;
  joinedMethod?: string;
  joinedAt?: string;
  /** Node id of the containing OU or organization root. */
  parentId: string;
  tags: Record<string, string>;
}

export interface OrgTree {
  root: GraphNode;
  ous: GraphNode[];
  accounts: OrgAccount[];
}

/** An account the collector will read resources from. */
export interface Target {
  accountId: string;
  nodeId: string;
  name: string;
}

export interface Scope {
  /** Organization root, OUs and account nodes. */
  nodes: GraphNode[];
  targets: Target[];
  /** One line for the log: where the account list came from. */
  description: string;
}

type Log = (message: string) => void;

export async function resolveScope(config: MizarConfig["aws"], caller: Caller, org: OrganizationsClient, log: Log): Promise<Scope> {
  const excluded = new Set(config.excludeAccounts);

  if (config.scope === "organization") {
    let tree: OrgTree;
    try {
      tree = await readOrganization(org, config);
    } catch (error) {
      throw new Error(
        `Could not read the AWS Organization from account ${caller.accountId} (${describeError(error)}). ` +
          'Run from the management account or a delegated administrator, or set aws.scope to "accounts" or "current".',
      );
    }
    return scopeFromTree(tree, (id) => !excluded.has(id), `organization ${tree.root.meta.orgId}`);
  }

  const wanted = config.scope === "current" ? [caller.accountId] : config.accounts;
  if (!wanted.length) throw new Error('aws.scope is "accounts" but aws.accounts is empty');
  const selected = new Set(wanted.filter((id) => !excluded.has(id)));

  // Names and OU placement are a bonus here: use the Organization when readable, otherwise list accounts flat.
  try {
    const tree = await readOrganization(org, config);
    const missing = [...selected].filter((id) => !tree.accounts.some((a) => a.id === id));
    if (missing.length) log(`not in organization ${tree.root.meta.orgId}, collected anyway: ${missing.join(", ")}`);
    const scope = scopeFromTree(tree, (id) => selected.has(id), `${selected.size} account(s) in organization ${tree.root.meta.orgId}`);
    return missing.length ? mergeStandalone(scope, missing) : scope;
  } catch {
    let organization: { arn: string; id: string } | undefined;
    try {
      const { Organization: o } = await org.send(new DescribeOrganizationCommand({}));
      if (o?.Arn && o.Id) organization = { arn: o.Arn, id: o.Id };
    } catch {
      // Not in an Organization (or not allowed to ask): a synthetic root keeps the graph single-rooted.
    }
    return standaloneScope([...selected], config.name, organization);
  }
}

async function readOrganization(org: OrganizationsClient, config: MizarConfig["aws"]): Promise<OrgTree> {
  const { Organization: o } = await org.send(new DescribeOrganizationCommand({}));
  if (!o?.Arn || !o.Id) throw new Error("DescribeOrganization returned no organization");
  const roots = await all(paginateListRoots({ client: org }, {}), (p) => p.Roots);
  const rootId = roots[0]?.Id;
  if (!rootId) throw new Error("ListRoots returned no root");

  const root: GraphNode = {
    id: o.Arn,
    type: "organization",
    name: config.name ?? o.Id,
    status: "ok",
    tags: {},
    meta: { orgId: o.Id, rootId, featureSet: o.FeatureSet ?? "", managementAccountId: o.MasterAccountId ?? "" },
  };
  const ous: GraphNode[] = [];
  const accounts: OrgAccount[] = [];

  // Breadth-first: two paginated calls per OU. Organizations allows only a few requests per second.
  let level: { awsId: string; nodeId: string }[] = [{ awsId: rootId, nodeId: root.id }];
  while (level.length) {
    const next: typeof level = [];
    await pool(2, level, async (parent) => {
      const [children, members] = await Promise.all([
        all(paginateListOrganizationalUnitsForParent({ client: org }, { ParentId: parent.awsId }), (p) => p.OrganizationalUnits),
        all(paginateListAccountsForParent({ client: org }, { ParentId: parent.awsId }), (p) => p.Accounts),
      ]);
      for (const ou of children) {
        if (!ou.Arn || !ou.Id) continue;
        ous.push({ id: ou.Arn, type: "ou", name: ou.Name ?? ou.Id, parentId: parent.nodeId, status: "ok", tags: {}, meta: { ouId: ou.Id } });
        next.push({ awsId: ou.Id, nodeId: ou.Arn });
      }
      for (const a of members) {
        if (!a.Id) continue;
        accounts.push({
          id: a.Id,
          name: a.Name ?? a.Id,
          arn: a.Arn,
          email: a.Email,
          state: a.State ?? a.Status ?? "ACTIVE",
          joinedMethod: a.JoinedMethod,
          joinedAt: a.JoinedTimestamp?.toISOString(),
          parentId: parent.nodeId,
          tags: {},
        });
      }
    });
    level = next;
  }

  // Account tags carry the environment in many landing zones. Best effort: missing tags only cost colour.
  await pool(2, accounts, async (account) => {
    try {
      account.tags = tagRecord(await all(paginateListTagsForResource({ client: org }, { ResourceId: account.id }), (p) => p.Tags));
    } catch {
      // ignore
    }
  });

  return { root, ous, accounts };
}

const STATUS_BY_STATE: Record<string, NodeStatus> = { ACTIVE: "ok", SUSPENDED: "stopped", PENDING_CLOSURE: "stopped", CLOSED: "stopped" };

function accountNode(account: OrgAccount, ouPath: string[]): GraphNode {
  const env = inferEnvironment(account.tags, account.name, ouPath);
  const original = account.tags.Environment;
  return {
    id: account.arn ?? `account/${account.id}`,
    type: "account",
    name: account.name,
    parentId: account.parentId,
    accountId: account.id,
    status: STATUS_BY_STATE[account.state] ?? "warning",
    // Renderers read `tags.Environment` as one of the known environments; keep any original value in meta.
    tags: { ...account.tags, Environment: env },
    meta: {
      accountStatus: account.state,
      ...(account.email ? { email: account.email } : {}),
      ...(account.joinedMethod ? { joinedMethod: account.joinedMethod } : {}),
      ...(account.joinedAt ? { joinedAt: account.joinedAt } : {}),
      ...(original !== undefined && original !== env ? { environmentTag: original } : {}),
    },
  };
}

/** Keeps the selected accounts, the OUs on their paths and the root. Only ACTIVE accounts become targets. */
export function scopeFromTree(tree: OrgTree, include: (accountId: string) => boolean, description: string): Scope {
  const ouById = new Map(tree.ous.map((ou) => [ou.id, ou]));
  const pathOf = (parentId: string): GraphNode[] => {
    const path: GraphNode[] = [];
    for (let ou = ouById.get(parentId); ou; ou = ou.parentId ? ouById.get(ou.parentId) : undefined) path.unshift(ou);
    return path;
  };

  const keptOus = new Set<string>();
  const accounts: GraphNode[] = [];
  const targets: Target[] = [];
  for (const account of tree.accounts) {
    if (!include(account.id)) continue;
    const path = pathOf(account.parentId);
    for (const ou of path) keptOus.add(ou.id);
    const node = accountNode(account, path.map((ou) => ou.name));
    accounts.push(node);
    if (account.state === "ACTIVE") targets.push({ accountId: account.id, nodeId: node.id, name: account.name });
  }
  const ous = tree.ous.filter((ou) => keptOus.has(ou.id));
  return { nodes: [tree.root, ...ous, ...accounts], targets, description };
}

/** Accounts without (readable) Organization structure, under the organization if known, else a synthetic root. */
export function standaloneScope(accountIds: string[], name?: string, organization?: { arn: string; id: string }): Scope {
  const root: GraphNode = organization
    ? { id: organization.arn, type: "organization", name: name ?? organization.id, status: "ok", tags: {}, meta: { orgId: organization.id } }
    : { id: "standalone", type: "organization", name: name ?? "AWS accounts", status: "ok", tags: {}, meta: { standalone: true } };
  const scope = mergeStandalone({ nodes: [root], targets: [], description: "" }, accountIds);
  scope.description = `${accountIds.length} account(s)${organization ? ` in organization ${organization.id} (structure not readable)` : ""}`;
  return scope;
}

function mergeStandalone(scope: Scope, accountIds: string[]): Scope {
  const root = scope.nodes.find((n) => !n.parentId)!;
  const nodes = [...scope.nodes];
  const targets = [...scope.targets];
  for (const id of accountIds) {
    const node = accountNode({ id, name: id, state: "ACTIVE", parentId: root.id, tags: {} }, []);
    nodes.push(node);
    targets.push({ accountId: id, nodeId: node.id, name: node.name });
  }
  return { ...scope, nodes, targets };
}

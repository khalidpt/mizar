import type { IpPermission, SecurityGroup } from "@aws-sdk/client-ec2";
import type { NodeType } from "@/lib/graph/types";
import type { GraphBuilder } from "./builder";

/** Ports that should never be open to the whole internet. */
const SENSITIVE_PORTS: Record<number, string> = {
  21: "FTP",
  22: "SSH",
  23: "Telnet",
  135: "RPC",
  445: "SMB",
  1433: "SQL Server",
  1521: "Oracle",
  2375: "Docker",
  2379: "etcd",
  3306: "MySQL",
  3389: "RDP",
  5432: "PostgreSQL",
  5601: "Kibana",
  5900: "VNC",
  6379: "Redis",
  9200: "Elasticsearch",
  11211: "Memcached",
  27017: "MongoDB",
};

/** Resource types whose inbound security group references reveal which apps use them. */
const DATA_STORES = new Set<NodeType>(["rds", "elasticache"]);
const CLIENTS = new Set<NodeType>(["ec2", "ecs-service", "lambda", "eks-cluster", "workspaces"]);
/** A widely shared security group would otherwise draw an edge from every member. */
const MAX_CLIENTS_PER_GROUP = 50;

const PROTOCOLS: Record<string, string> = { "-1": "all", "6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6" };

export function describePermission(p: IpPermission): string {
  const protocol = PROTOCOLS[p.IpProtocol ?? "-1"] ?? p.IpProtocol!;
  if (protocol === "all") return "all traffic";
  if (protocol === "icmp" || protocol === "icmpv6") return protocol;
  const { FromPort: from, ToPort: to } = p;
  if (from === undefined || to === undefined || (from <= 0 && to >= 65535) || from === -1) return `${protocol}/all ports`;
  return from === to ? `${protocol}/${from}` : `${protocol}/${from}-${to}`;
}

const openToWorld = (p: IpPermission) =>
  !!p.IpRanges?.some((r) => r.CidrIp === "0.0.0.0/0") || !!p.Ipv6Ranges?.some((r) => r.CidrIpv6 === "::/0");

/** Sensitive services a world-open permission exposes, e.g. `SSH (tcp/22)` or `all traffic`. */
export function sensitiveExposure(p: IpPermission): string[] {
  const protocol = PROTOCOLS[p.IpProtocol ?? "-1"] ?? p.IpProtocol!;
  if (protocol === "all") return ["all traffic"];
  if (protocol !== "tcp" && protocol !== "udp") return [];
  const from = p.FromPort ?? 0;
  const to = p.ToPort ?? 65535;
  const hits = Object.entries(SENSITIVE_PORTS).filter(([port]) => Number(port) >= from && Number(port) <= to);
  if (hits.length > 3) return [`${describePermission(p)} (incl. ${hits.slice(0, 3).map(([, name]) => name).join(", ")})`];
  return hits.map(([port, name]) => `${name} (${protocol}/${port})`);
}

interface Member {
  nodeId: string;
  type: NodeType;
  groupIds: string[];
  /** Has a public address (public IP, internet-facing scheme, publicly accessible), so world-open rules apply. */
  isPublic: boolean;
}

/**
 * Security groups seen across all accounts and the resources that use them. Collected during discovery, then applied
 * once every account is done, because a database's group may reference an application's group in another account.
 * Nothing new enters the snapshot format: findings are node attributes, statuses and `connects` edges.
 */
export class SecurityGroups {
  private readonly groups = new Map<string, { name: string; inbound: IpPermission[] }>();
  private readonly members: Member[] = [];

  addGroups(groups: readonly SecurityGroup[]): void {
    for (const g of groups) {
      if (g.GroupId) this.groups.set(g.GroupId, { name: g.GroupName ?? g.GroupId, inbound: g.IpPermissions ?? [] });
    }
  }

  attach(nodeId: string, type: NodeType, groupIds: readonly (string | undefined)[] | undefined, isPublic: boolean): void {
    const ids = [...new Set((groupIds ?? []).filter((id): id is string => !!id))];
    if (ids.length) this.members.push({ nodeId, type, groupIds: ids, isPublic });
  }

  apply(b: GraphBuilder): void {
    const byGroup = new Map<string, Member[]>();
    for (const m of this.members) for (const id of m.groupIds) byGroup.set(id, [...(byGroup.get(id) ?? []), m]);

    for (const m of this.members) {
      const inbound = m.groupIds.flatMap((id) => this.groups.get(id)?.inbound ?? []);
      const open = m.isPublic ? inbound.filter(openToWorld) : [];
      const ports = [...new Set(open.map(describePermission))];
      const sensitive = [...new Set(open.flatMap(sensitiveExposure))];

      b.update(m.nodeId, (node) => {
        node.meta.securityGroups = m.groupIds.map((id) => this.groups.get(id)?.name ?? id).join(", ");
        if (ports.length) node.meta.internetIngress = ports.join(", ");
        if (sensitive.length) {
          node.meta.exposure = `${sensitive.join(", ")} open to the internet`;
          if (node.status === "ok") node.status = "warning";
        }
      });

      // "The database's group allows the app's group" is the closest thing AWS has to "this app uses this database".
      if (!DATA_STORES.has(m.type)) continue;
      for (const id of m.groupIds) {
        for (const permission of this.groups.get(id)?.inbound ?? []) {
          for (const pair of permission.UserIdGroupPairs ?? []) {
            if (!pair.GroupId || pair.GroupId === id) continue;
            const clients = (byGroup.get(pair.GroupId) ?? []).filter((c) => CLIENTS.has(c.type) && c.nodeId !== m.nodeId);
            for (const client of clients.slice(0, MAX_CLIENTS_PER_GROUP)) b.link("connects", client.nodeId, m.nodeId);
          }
        }
      }
    }
  }
}

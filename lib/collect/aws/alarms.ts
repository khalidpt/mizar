import type { Dimension, MetricAlarm } from "@aws-sdk/client-cloudwatch";
import type { GraphNode } from "@/lib/graph/types";
import { arn } from "./util";

export interface AlarmScope {
  partition: string;
  accountId: string;
  region: string;
}

/** ALB/NLB metrics name load balancers by the ARN suffix after `loadbalancer/` (`app/<name>/<id>`). */
export const elbRef = (loadBalancerArn: string) => `elb:${loadBalancerArn.split(":loadbalancer/")[1] ?? loadBalancerArn}`;

/** ElastiCache ids (replication groups, member clusters, serverless caches) are chosen by users: scope them. */
export const cacheRef = (s: Pick<AlarmScope, "accountId" | "region">, id: string) => `elasticache:${s.accountId}/${s.region}/${id}`;
/** API Gateway ids are random and global; CloudFront origins (`<id>.execute-api…`) and HTTP API metrics use them. */
export const apiRef = (apiId: string) => `apigw:${apiId}`;
/** REST API metrics name APIs by their (user-chosen) name. */
export const apiNameRef = (s: Pick<AlarmScope, "accountId" | "region">, name: string) => `apigw-name:${s.accountId}/${s.region}/${name}`;
export const distributionRef = (distributionId: string) => `cloudfront:${distributionId}`;
/** Network Firewall metrics name firewalls by their (user-chosen) name. */
export const firewallRef = (s: Pick<AlarmScope, "accountId" | "region">, name: string) => `nfw:${s.accountId}/${s.region}/${name}`;
/** WorkSpaces metrics name a WorkSpace or a directory; both resolve to the directory's node. */
export const workspacesRef = (id: string) => `workspaces:${id}`;

/** The node (as a builder ref) one metric's dimensions point at, if Mizar models that resource. */
function refFor(namespace: string | undefined, dimensions: readonly Dimension[] | undefined, s: AlarmScope): string | undefined {
  const d = Object.fromEntries((dimensions ?? []).flatMap((x) => (x.Name && x.Value ? [[x.Name, x.Value]] : [])));
  const at = (service: string, resource: string) => arn(s.partition, service, s.region, s.accountId, resource);

  if (d.InstanceId) return `ec2:${d.InstanceId}`;
  if (d.NatGatewayId) return `ec2:${d.NatGatewayId}`;
  if (d.TransitGateway) return `ec2:${d.TransitGateway}`;
  if (d.VpnId) return `ec2:${d.VpnId}`;
  if (d.DBInstanceIdentifier) return at("rds", `db:${d.DBInstanceIdentifier}`);
  if (d.LoadBalancer && namespace !== "AWS/ELB") return `elb:${d.LoadBalancer}`;
  if (d.FunctionName) return at("lambda", `function:${d.FunctionName}`);
  if (d.QueueName) return at("sqs", d.QueueName);
  if (d.TableName) return at("dynamodb", `table/${d.TableName}`);
  if (d.ClusterName && d.ServiceName) return at("ecs", `service/${d.ClusterName}/${d.ServiceName}`);
  if (d.ClusterName && (namespace === "AWS/EKS" || namespace === "ContainerInsights")) return at("eks", `cluster/${d.ClusterName}`);
  if (d.BucketName) return `arn:${s.partition}:s3:::${d.BucketName}`;
  if (d.CacheClusterId) return cacheRef(s, d.CacheClusterId);
  if (d.ReplicationGroupId) return cacheRef(s, d.ReplicationGroupId);
  if (namespace === "AWS/ElastiCache" && d.clusterId) return cacheRef(s, d.clusterId);
  if (d.ApiId) return apiRef(d.ApiId);
  if (d.ApiName) return apiNameRef(s, d.ApiName);
  if (d.DistributionId) return distributionRef(d.DistributionId);
  if (namespace === "AWS/NetworkFirewall" && d.FirewallName) return firewallRef(s, d.FirewallName);
  if (namespace === "AWS/WorkSpaces" && (d.WorkspaceId || d.DirectoryId)) return workspacesRef(d.WorkspaceId ?? d.DirectoryId);
  return undefined;
}

/** Refs of every modelled resource an alarm watches: its own metric, or each metric of a metric-math alarm. */
export function alarmTargets(alarm: MetricAlarm, scope: AlarmScope): string[] {
  const refs = [
    refFor(alarm.Namespace, alarm.Dimensions, scope),
    ...(alarm.Metrics ?? []).map((m) => refFor(m.MetricStat?.Metric?.Namespace, m.MetricStat?.Metric?.Dimensions, scope)),
  ];
  return [...new Set(refs.filter((r): r is string => !!r))];
}

/**
 * Records a firing alarm. On the resource it watches: the resource becomes critical. On the account (`otherAlarms`,
 * for alarms on things Mizar doesn't draw): the account becomes a warning, so the alarm still surfaces.
 * A few names are listed, then a count.
 */
export function markAlarm(node: GraphNode, alarmName: string, key: "alarms" | "otherAlarms" = "alarms"): void {
  const names = String(node.meta[key] ?? "")
    .split("; ")
    .filter((n) => n && !n.startsWith("… +"));
  const count = Number(node.meta[`${key}Count`] ?? 0) + 1;
  if (names.length < 3) names.push(alarmName);
  node.meta[key] = names.join("; ") + (count > names.length ? `; … +${count - names.length}` : "");
  node.meta[`${key}Count`] = count;
  if (key === "alarms") node.status = "critical";
  else if (node.status === "ok") node.status = "warning";
}

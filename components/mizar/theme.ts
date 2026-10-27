import type { EdgeKind, Environment, NodeStatus, NodeType } from "@/lib/graph/types";

export const BACKGROUND = "#02040b";
export const HUD_ACCENT = "#5eead4";

export const ENV_COLOR: Record<Environment, string> = {
  prod: "#ff4d6d",
  staging: "#ffb547",
  dev: "#38bdf8",
  shared: "#a78bfa",
  sandbox: "#4ade80",
};

export const TYPE_COLOR: Record<NodeType, string> = {
  organization: "#e0f2fe",
  ou: "#5eead4",
  account: "#e0f2fe",
  region: "#5eead4",
  vpc: "#22d3ee",
  subnet: "#22d3ee",
  igw: "#67e8f9",
  "nat-gateway": "#67e8f9",
  tgw: "#22d3ee",
  "vpn-gateway": "#67e8f9",
  "vpn-connection": "#93c5fd",
  // Pale "wall" white: the type palette has no free hue left that isn't a status colour.
  "network-firewall": "#e2e8f0",
  cloudfront: "#7dd3fc",
  "api-gateway": "#34d399",
  ec2: "#60a5fa",
  "ecs-service": "#2dd4bf",
  "eks-cluster": "#818cf8",
  lambda: "#fb923c",
  elb: "#a3e635",
  workspaces: "#f9a8d4",
  rds: "#c084fc",
  // Soft rose rather than red, so a healthy cache never reads as critical.
  elasticache: "#fda4af",
  dynamodb: "#e879f9",
  s3: "#f472b6",
  sqs: "#facc15",
};

export const TYPE_LABEL: Record<NodeType, string> = {
  organization: "Organization",
  ou: "Organizational unit",
  account: "Account",
  region: "Region",
  vpc: "VPC",
  subnet: "Subnet",
  igw: "Internet gateway",
  "nat-gateway": "NAT gateway",
  tgw: "Transit gateway",
  "vpn-gateway": "Virtual private gateway",
  "vpn-connection": "Site-to-Site VPN",
  "network-firewall": "Network Firewall",
  cloudfront: "CloudFront distribution",
  "api-gateway": "API Gateway API",
  ec2: "EC2 instance",
  "ecs-service": "ECS service",
  "eks-cluster": "EKS cluster",
  lambda: "Lambda function",
  elb: "Load balancer",
  workspaces: "WorkSpaces directory",
  rds: "RDS database",
  elasticache: "ElastiCache cache",
  dynamodb: "DynamoDB table",
  s3: "S3 bucket",
  sqs: "SQS queue",
};

export const EDGE_COLOR: Record<EdgeKind, string> = {
  routes: "#22d3ee",
  peering: "#f472b6",
  "tgw-attachment": "#5eead4",
  vpn: "#93c5fd",
  targets: "#a3e635",
  invokes: "#fb923c",
  connects: "#c084fc",
};

export const STATUS_COLOR: Record<NodeStatus, string> = {
  ok: "#5eead4",
  warning: "#ffb547",
  critical: "#ff3b3b",
  stopped: "#475569",
};

/** Status overrides type color for anything that needs attention. */
export function nodeColor(type: NodeType, status: NodeStatus): string {
  return status === "ok" ? TYPE_COLOR[type] : STATUS_COLOR[status];
}

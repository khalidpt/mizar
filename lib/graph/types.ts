/**
 * Infrastructure graph model shared by the collector (mock or AWS) and both renderers (2D / 3D).
 *
 * Containment (org → OU → account → region → VPC → subnet → resource) is expressed only through
 * `parentId`. `edges` hold every non-containment relationship (routing, peering, load balancing, ...).
 */

export type NodeType =
  // Organization structure
  | "organization"
  | "ou"
  | "account"
  | "region"
  // Networking
  | "vpc"
  | "subnet"
  | "igw"
  | "nat-gateway"
  | "tgw"
  | "vpn-gateway"
  | "vpn-connection"
  | "network-firewall"
  // Edge and APIs
  | "cloudfront"
  | "api-gateway"
  // Compute
  | "ec2"
  | "ecs-service"
  | "eks-cluster"
  | "lambda"
  | "elb"
  | "workspaces"
  // Data & messaging
  | "rds"
  | "elasticache"
  | "dynamodb"
  | "s3"
  | "sqs";

export type EdgeKind =
  /**
   * Subnet route table → IGW / NAT gateway / TGW / virtual private gateway / Network Firewall endpoint; also gateway
   * route table (ingress routing) → firewall endpoint.
   */
  | "routes"
  /** VPC ↔ VPC peering connection. */
  | "peering"
  /** VPC (or a Network Firewall attached directly) → transit gateway (often cross-account via RAM). */
  | "tgw-attachment"
  /** Site-to-Site VPN connection → the virtual private gateway or transit gateway it terminates on. */
  | "vpn"
  /** Load balancer → target (EC2 instance, ECS service), or CloudFront distribution → origin. */
  | "targets"
  /** Event source / caller → Lambda, API Gateway → its integration, or Lambda → downstream service. */
  | "invokes"
  /** Application → data store it reads/writes. */
  | "connects";

export type NodeStatus = "ok" | "warning" | "critical" | "stopped";

export type Environment = "prod" | "staging" | "dev" | "shared" | "sandbox";

export interface GraphNode {
  /** ARN where AWS has one; otherwise a stable synthetic id (OU, region, organization root). */
  id: string;
  type: NodeType;
  name: string;
  /** Containment parent. Undefined only for the organization root. */
  parentId?: string;
  /** Owning account. Undefined for organization and OU nodes. */
  accountId?: string;
  region?: string;
  /** Subnets only: the AZ they live in. Renderers group subnets by AZ inside a VPC. */
  az?: string;
  status: NodeStatus;
  tags: Record<string, string>;
  /** Type-specific attributes (cidr, instanceType, engine, ...). Display only. */
  meta: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
}

export interface InfraGraph {
  version: 1;
  source: "mock" | "aws";
  /** ISO timestamp of when the snapshot was collected. */
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

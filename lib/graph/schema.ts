import { z } from "zod";
import { validateGraph } from "./query";
import type { InfraGraph } from "./types";

/**
 * The snapshot contract (`InfraGraph`, version 1) as a schema: `types.ts` stays the readable TypeScript definition,
 * this mirrors it (checked at compile time below) and generates the published JSON Schema
 * (`schema/infra-graph.v1.schema.json`, `npm run schema`). Change both only with a version bump.
 */

const NodeTypeSchema = z
  .enum([
    "organization",
    "ou",
    "account",
    "region",
    "vpc",
    "subnet",
    "igw",
    "nat-gateway",
    "tgw",
    "vpn-gateway",
    "vpn-connection",
    "network-firewall",
    "cloudfront",
    "api-gateway",
    "ec2",
    "ecs-service",
    "eks-cluster",
    "lambda",
    "elb",
    "workspaces",
    "rds",
    "elasticache",
    "dynamodb",
    "s3",
    "sqs",
  ])
  .describe("What the node is. Organization structure: organization, ou, account, region. Everything else is a resource or network component.");

const EdgeKindSchema = z
  .enum(["routes", "peering", "tgw-attachment", "vpn", "targets", "invokes", "connects"])
  .describe(
    "routes: subnet route table → IGW / NAT gateway / TGW / virtual private gateway / Network Firewall endpoint, or " +
      "gateway route table (ingress routing) → firewall endpoint. peering: VPC ↔ VPC. " +
      "tgw-attachment: VPC (or a Network Firewall attached directly) → transit gateway. vpn: Site-to-Site VPN connection → its virtual private gateway or transit gateway. " +
      "targets: load balancer → target, or CloudFront distribution → origin. invokes: event source or caller → Lambda, " +
      "API Gateway → its integration, or Lambda → downstream. " +
      "connects: application → data store.",
  );

export const GraphNodeSchema = z
  .strictObject({
    id: z.string().min(1).describe("ARN where AWS has one; otherwise a stable synthetic id (OU, region `region/<accountId>/<region>`, organization root). Unique."),
    type: NodeTypeSchema,
    name: z.string().describe("Display name."),
    parentId: z.string().min(1).optional().describe("Containment parent (organization → OU → account → region → VPC → subnet → resource). Absent only on the single root."),
    accountId: z.string().regex(/^\d{12}$/).optional().describe("Owning account. Absent on organization and OU nodes."),
    region: z.string().min(1).optional(),
    az: z.string().min(1).optional().describe("Subnets only: their Availability Zone."),
    status: z.enum(["ok", "warning", "critical", "stopped"]),
    tags: z.record(z.string(), z.string()),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Type-specific attributes (cidr, instanceType, engine, ...). Display only."),
  })
  .meta({ id: "GraphNode", description: "A node. Containment is expressed only through parentId." });

export const GraphEdgeSchema = z
  .strictObject({
    id: z.string().min(1).describe("Unique."),
    kind: EdgeKindSchema,
    from: z.string().min(1).describe("Node id."),
    to: z.string().min(1).describe("Node id."),
  })
  .meta({ id: "GraphEdge", description: "A non-containment relationship between two nodes." });

export const InfraGraphSchema = z
  .strictObject({
    version: z.literal(1),
    source: z.enum(["mock", "aws"]).describe("Collector that produced the snapshot."),
    generatedAt: z.iso.datetime().describe("When the snapshot was collected (ISO 8601, UTC)."),
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .describe(
    "One infrastructure snapshot. Beyond this schema: node and edge ids are unique, exactly one node has no parentId, " +
      "and every parentId, from and to names an existing node.",
  );

// Compile-time guard: the schema and the TypeScript types describe exactly the same shape.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameShape: Same<z.infer<typeof InfraGraphSchema>, InfraGraph> = true;
void sameShape;

/** The published JSON Schema document. */
export function infraGraphJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Mizar infrastructure snapshot (InfraGraph v1)",
    ...z.toJSONSchema(InfraGraphSchema, { target: "draft-2020-12" }),
  };
}

/** Everything wrong with a snapshot: shape (the schema) first, then the rules a schema can't express. */
export function checkSnapshot(value: unknown): string[] {
  const parsed = InfraGraphSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 50).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return validateGraph(parsed.data);
}

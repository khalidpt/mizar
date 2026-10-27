"use client";

import { Billboard, Edges, useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Suspense, useMemo, useRef } from "react";
import { Color, DoubleSide, SRGBColorSpace, type Group, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import type { GraphNode, NodeType } from "@/lib/graph/types";
import { BACKGROUND, nodeColor } from "./theme";
import { useMizar } from "./store";

/** Unit-sized silhouette per resource type, so types are distinguishable without reading labels. */
export function ResourceGeometry({ type }: { type: NodeType }) {
  switch (type) {
    case "ec2":
      return <boxGeometry args={[0.9, 0.9, 0.9]} />;
    case "ecs-service":
      return <octahedronGeometry args={[0.65]} />;
    case "eks-cluster":
      return <dodecahedronGeometry args={[0.65]} />;
    case "lambda":
      return <coneGeometry args={[0.55, 1, 3]} />;
    case "elb":
      return <torusGeometry args={[0.42, 0.14, 8, 24]} />;
    case "rds":
      return <cylinderGeometry args={[0.45, 0.45, 0.85, 20]} />;
    case "elasticache":
      return <capsuleGeometry args={[0.32, 0.45, 4, 12]} />;
    case "api-gateway":
      return <torusKnotGeometry args={[0.32, 0.1, 64, 8]} />;
    case "cloudfront":
      return <sphereGeometry args={[0.55, 10, 6]} />;
    case "dynamodb":
      return <cylinderGeometry args={[0.5, 0.5, 0.75, 6]} />;
    case "s3":
      return <cylinderGeometry args={[0.55, 0.38, 0.85, 16]} />;
    case "sqs":
      return <boxGeometry args={[1.2, 0.4, 0.55]} />;
    case "igw":
      return <torusGeometry args={[0.42, 0.1, 6, 6]} />;
    case "nat-gateway":
      return <icosahedronGeometry args={[0.5, 0]} />;
    case "tgw":
      return <torusGeometry args={[0.55, 0.18, 8, 6]} />;
    case "vpn-gateway":
      return <torusGeometry args={[0.42, 0.12, 6, 4]} />;
    case "vpn-connection":
      // A tunnel, lying flat (see the rotation below).
      return <cylinderGeometry args={[0.26, 0.26, 1.15, 12]} />;
    case "network-firewall":
      // An octagonal shield, standing upright (see the rotation below).
      return <cylinderGeometry args={[0.55, 0.55, 0.28, 8]} />;
    case "workspaces":
      // A screen.
      return <boxGeometry args={[1.1, 0.7, 0.12]} />;
    default:
      return <sphereGeometry args={[0.5, 16, 16]} />;
  }
}

/** Types with an AWS Architecture Icon in public/icons/aws (see scripts/import-aws-icons.mjs). */
const ICON_TYPES = new Set<NodeType>([
  "ec2", "ecs-service", "eks-cluster", "lambda", "elb", "workspaces", "rds", "elasticache", "dynamodb", "s3", "sqs",
  "api-gateway", "cloudfront", "tgw", "network-firewall", "igw", "nat-gateway", "vpn-gateway", "vpn-connection",
]);

const iconUrl = (type: NodeType) => `/icons/aws/${type}.svg`;

/** Glow multiplier for the current status; critical resources pulse, warnings flicker gently. */
function glow(status: GraphNode["status"], t: number): number {
  const base = status === "stopped" ? 0.25 : 1.1;
  return status === "critical" ? 1.3 + Math.sin(t * 6) * 0.9 : status === "warning" ? base + Math.sin(t * 2.5) * 0.35 : base;
}

/** A clickable glowing resource: a camera-facing holo-card when the type has an icon, a silhouette otherwise. */
export function ResourceNode({ node, position, size }: { node: GraphNode; position: [number, number, number]; size: number }) {
  const group = useRef<Group>(null);
  const selected = useMizar((s) => s.selectedId === node.id);
  const hovered = useMizar((s) => s.hoveredId === node.id);
  const select = useMizar((s) => s.select);
  const hover = useMizar((s) => s.hover);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const target = size * (selected ? 1.5 : hovered ? 1.3 : 1);
    g.scale.setScalar(g.scale.x + (target - g.scale.x) * Math.min(1, delta * 10));
  });

  return (
    <group
      ref={group}
      position={position}
      scale={size}
      onClick={(e) => {
        e.stopPropagation();
        select(node.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover(node.id);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        hover(null);
        document.body.style.cursor = "";
      }}
    >
      {ICON_TYPES.has(node.type) ? (
        <Suspense fallback={<Silhouette node={node} />}>
          <HoloCard node={node} highlighted={selected || hovered} />
        </Suspense>
      ) : (
        <Silhouette node={node} />
      )}
    </group>
  );
}

/** The service icon on a translucent card that always faces the camera, over a ring marking its spot. */
function HoloCard({ node, highlighted }: { node: GraphNode; highlighted: boolean }) {
  const texture = useTexture(iconUrl(node.type), (t) => {
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
  });
  const glyph = useRef<MeshBasicMaterial>(null);
  const ring = useRef<Mesh>(null);
  const color = nodeColor(node.type, node.status);
  const tint = useMemo(() => new Color(color), [color]);

  useFrame(({ clock }, delta) => {
    glyph.current?.color.copy(tint).multiplyScalar(glow(node.status, clock.elapsedTime));
    if (ring.current) ring.current.rotation.z += delta * 0.6;
  });

  return (
    <>
      <Billboard>
        <mesh>
          <planeGeometry args={[1.15, 1.15]} />
          <meshBasicMaterial color={BACKGROUND} transparent opacity={highlighted ? 0.85 : 0.6} depthWrite={false} />
          <Edges color={highlighted ? "#ffffff" : color} />
        </mesh>
        <mesh position-z={0.01}>
          <planeGeometry args={[1.1, 1.1]} />
          <meshBasicMaterial ref={glyph} map={texture} color={color} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      </Billboard>
      <mesh ref={ring} position-y={-0.75} rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={[0.38, 0.46, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.45} side={DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

/** The geometric fallback, also shown while an icon loads. */
function Silhouette({ node }: { node: GraphNode }) {
  const mesh = useRef<Mesh>(null);
  const color = nodeColor(node.type, node.status);

  useFrame(({ clock }, delta) => {
    if (!mesh.current) return;
    (mesh.current.material as MeshStandardMaterial).emissiveIntensity = glow(node.status, clock.elapsedTime) * 1.3;
    mesh.current.rotation.y += delta * (node.type === "elb" || node.type === "tgw" ? 0.8 : 0.25);
  });

  return (
    <mesh
      ref={mesh}
      rotation-x={["elb", "igw", "tgw", "vpn-gateway", "vpn-connection", "network-firewall"].includes(node.type) ? Math.PI / 2 : 0}
    >
      <ResourceGeometry type={node.type} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} toneMapped={false} />
    </mesh>
  );
}

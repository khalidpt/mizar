"use client";

import { Edges, Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AdditiveBlending, DoubleSide, QuadraticBezierCurve3, Vector3, type Group } from "three";
import type { GraphEdge, GraphNode } from "@/lib/graph/types";
import { useSceneData } from "./data";
import { Flow } from "./Flow";
import { hologramTransform, type HoloItem, type Planet, type Vec3 } from "./layout";
import { ResourceNode } from "./shapes";
import { useMizar } from "./store";
import { EDGE_COLOR, HUD_ACCENT, TYPE_COLOR, TYPE_LABEL } from "./theme";

/** An account "unfolded" into a holographic stack above its planet: region layers → VPCs → subnets → resources. */
export function Hologram({ planet }: { planet: Planet }) {
  const { index, hologram } = useSceneData();
  const holo = hologram(planet.account.id);
  const { origin, scale } = hologramTransform(planet, holo);
  const group = useRef<Group>(null);
  const focusId = useMizar((s) => s.hoveredId ?? s.selectedId);
  const hiddenEdgeKinds = useMizar((s) => s.hiddenEdgeKinds);

  const edges = useMemo(() => {
    const seen = new Map<string, GraphEdge>();
    for (const item of holo.items) {
      for (const edge of index.edgesOf.get(item.node.id) ?? []) {
        if (holo.positionOf.has(edge.from) && holo.positionOf.has(edge.to)) seen.set(edge.id, edge);
      }
    }
    return [...seen.values()];
  }, [holo, index]);

  // Unfold animation on mount.
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    g.scale.setScalar(g.scale.x + (scale - g.scale.x) * Math.min(1, delta * 4));
  });

  const focusItem = focusId ? holo.items.find((i) => i.node.id === focusId && i.role === "resource") : undefined;
  const beamTop = (Math.max(holo.width, holo.depth) * scale) / 2.4;

  return (
    <>
      <mesh position={[planet.position[0], planet.position[1] + planet.radius + 1.25, planet.position[2]]} raycast={() => null}>
        <cylinderGeometry args={[beamTop, 0.4, 2.5, 32, 1, true]} />
        <meshBasicMaterial color={HUD_ACCENT} transparent opacity={0.07} side={DoubleSide} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      <group ref={group} position={origin} scale={0.01}>
        {holo.items.map((item) => (
          <HoloElement key={item.node.id} item={item} />
        ))}
        {edges.filter((edge) => !hiddenEdgeKinds.has(edge.kind)).map((edge) => (
          <HoloEdge key={edge.id} edge={edge} from={holo.positionOf.get(edge.from)!} to={holo.positionOf.get(edge.to)!} />
        ))}
        {focusItem && <FocusTag node={focusItem.node} position={focusItem.position} />}
      </group>
    </>
  );
}

function HoloElement({ item }: { item: HoloItem }) {
  switch (item.role) {
    case "resource":
      return <ResourceNode node={item.node} position={item.position} size={item.size[0]} />;
    case "layer":
      return <LayerPlatform item={item} />;
    default:
      return <Platform item={item} />;
  }
}

function LayerPlatform({ item }: { item: HoloItem }) {
  const select = useMizar((s) => s.select);
  const [w, , d] = item.size;
  return (
    <group position={item.position}>
      <gridHelper args={[Math.max(w, d), Math.round(Math.max(w, d)), HUD_ACCENT, HUD_ACCENT]} scale={[w / Math.max(w, d), 1, d / Math.max(w, d)]}>
        <lineBasicMaterial attach="material" color={HUD_ACCENT} transparent opacity={0.08} />
      </gridHelper>
      <mesh raycast={() => null}>
        <boxGeometry args={item.size} />
        <meshBasicMaterial color={HUD_ACCENT} transparent opacity={0.025} depthWrite={false} />
        <Edges color={HUD_ACCENT} />
      </mesh>
      <Html position={[-w / 2, 0, -d / 2]} zIndexRange={[10, 0]}>
        <button
          onClick={() => select(item.node.id)}
          className="-translate-y-full whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.25em] text-teal-300 hover:text-white"
        >
          ◈ {item.node.name}
        </button>
      </Html>
    </group>
  );
}

function Platform({ item }: { item: HoloItem }) {
  const { node } = item;
  const selected = useMizar((s) => s.selectedId === node.id);
  const hovered = useMizar((s) => s.hoveredId === node.id);
  const select = useMizar((s) => s.select);
  const hover = useMizar((s) => s.hover);
  const color = TYPE_COLOR[node.type];
  const isVpc = node.type === "vpc";
  const tier = String(node.meta.tier ?? "");
  const fill = isVpc ? 0.05 : tier === "public" ? 0.14 : tier === "data" ? 0.06 : 0.1;

  return (
    <group position={item.position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          select(node.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover(node.id);
        }}
        onPointerOut={() => hover(null)}
      >
        <boxGeometry args={item.size} />
        <meshBasicMaterial
          color={tier === "data" ? TYPE_COLOR.rds : color}
          transparent
          opacity={selected ? 0.35 : hovered ? 0.25 : fill}
          depthWrite={false}
          toneMapped={false}
        />
        <Edges color={selected ? "#ffffff" : color} />
      </mesh>
      {isVpc && (
        <Html position={[-item.size[0] / 2, 0, -item.size[2] / 2]} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className="-translate-y-full whitespace-nowrap font-mono text-[9px] uppercase tracking-widest text-cyan-300/90">
            {node.name} <span className="text-slate-400">{String(node.meta.cidr)}</span>
          </div>
        </Html>
      )}
    </group>
  );
}

function HoloEdge({ edge, from, to }: { edge: GraphEdge; from: Vec3; to: Vec3 }) {
  const color = EDGE_COLOR[edge.kind];
  const { points, curve } = useMemo(() => {
    const a = new Vector3(...from);
    const b = new Vector3(...to);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += 0.6 + a.distanceTo(b) * 0.12;
    const curve = new QuadraticBezierCurve3(a, mid, b);
    return { points: curve.getPoints(24), curve };
  }, [from, to]);

  return (
    <group>
      <Line points={points} color={color} lineWidth={1} transparent opacity={0.4} />
      <Flow curve={curve} color={color} count={1} speed={0.35} width={2} />
    </group>
  );
}

function FocusTag({ node, position }: { node: GraphNode; position: Vec3 }) {
  return (
    <Html position={[position[0], position[1] + 0.5, position[2]]} center zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
      <div className="-translate-y-full whitespace-nowrap border border-teal-300/50 bg-slate-950/80 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-teal-100">
        <span style={{ color: TYPE_COLOR[node.type] }}>{TYPE_LABEL[node.type]}</span> · {node.name}
      </div>
    </Html>
  );
}

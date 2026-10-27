"use client";

import { Html, Line, QuadraticBezierLine } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AdditiveBlending, BackSide, QuadraticBezierCurve3, Vector3, type Group, type Mesh } from "three";
import { accountColor, spendLabel } from "./cost";
import { useSceneData } from "./data";
import { Flow } from "./Flow";
import type { Arc, Planet, Ring } from "./layout";
import { useMizar } from "./store";
import { EDGE_COLOR, HUD_ACCENT } from "./theme";

/** Org-level view: the organization core, one orbital ring per OU, accounts as planets, cross-account arcs. */
export function OrgSystem() {
  const { org } = useSceneData();
  const hiddenEdgeKinds = useMizar((s) => s.hiddenEdgeKinds);
  return (
    <group>
      <Core />
      {org.rings.map((ring, i) => (
        <OrbitRing key={ring.id} ring={ring} labelAngle={Math.PI / 2 + (i - (org.rings.length - 1) / 2) * 0.22} />
      ))}
      {org.planets.map((planet) => (
        <PlanetBody key={planet.account.id} planet={planet} />
      ))}
      {org.arcs.filter((arc) => !hiddenEdgeKinds.has(arc.kind)).map((arc) => (
        <AccountArc key={arc.id} arc={arc} />
      ))}
    </group>
  );
}

function Core() {
  const { index } = useSceneData();
  const shell = useRef<Mesh>(null);
  const select = useMizar((s) => s.select);

  useFrame((_, delta) => {
    if (!shell.current) return;
    shell.current.rotation.y += delta * 0.15;
    shell.current.rotation.x += delta * 0.05;
  });

  return (
    <group>
      <pointLight intensity={400} distance={400} color="#bae6fd" />
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          select(index.root.id);
        }}
      >
        <icosahedronGeometry args={[3, 1]} />
        <meshStandardMaterial color="#e0f2fe" emissive="#7dd3fc" emissiveIntensity={2.2} toneMapped={false} flatShading />
      </mesh>
      <mesh ref={shell} raycast={() => null}>
        <icosahedronGeometry args={[4.4, 1]} />
        <meshBasicMaterial color={HUD_ACCENT} wireframe transparent opacity={0.35} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <sphereGeometry args={[7, 32, 32]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.06} side={BackSide} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function OrbitRing({ ring, labelAngle }: { ring: Ring; labelAngle: number }) {
  const selected = useMizar((s) => s.selectedId === ring.id);
  const select = useMizar((s) => s.select);
  const points = useMemo(
    () =>
      Array.from({ length: 161 }, (_, i) => {
        const a = (i / 160) * Math.PI * 2;
        return [Math.cos(a) * ring.radius, 0, Math.sin(a) * ring.radius] as [number, number, number];
      }),
    [ring.radius],
  );

  return (
    <group rotation-x={ring.tilt}>
      <Line points={points} color={HUD_ACCENT} lineWidth={selected ? 2 : 1} transparent opacity={selected ? 0.8 : 0.22} />
      {/* Fanned across the front arc so labels of neighbouring rings don't collide. */}
      <Html position={[Math.cos(labelAngle) * ring.radius, 0, Math.sin(labelAngle) * ring.radius]} center zIndexRange={[10, 0]}>
        <button
          onClick={() => select(ring.id)}
          className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.3em] text-teal-300/70 hover:text-teal-200"
        >
          ◇ {ring.label}
        </button>
      </Html>
    </group>
  );
}

function PlanetBody({ planet }: { planet: Planet }) {
  const { account, radius, position } = planet;
  const { cost } = useSceneData();
  const colorBy = useMizar((s) => s.colorBy);
  const selected = useMizar((s) => s.selectedId === account.id);
  const hovered = useMizar((s) => s.hoveredId === account.id);
  const select = useMizar((s) => s.select);
  const hover = useMizar((s) => s.hover);
  const wire = useRef<Mesh>(null);
  const halo = useRef<Group>(null);
  const label = useRef<HTMLDivElement>(null);
  const suspended = account.status === "stopped";
  const color = accountColor(account, planet.env, colorBy, cost);
  const spend = spendLabel(cost, account);
  const center = useMemo(() => new Vector3(...position), [position]);

  useFrame(({ camera }, delta) => {
    if (wire.current) wire.current.rotation.y += delta * 0.2;
    if (halo.current) halo.current.rotation.z += delta * 0.6;
    if (label.current) {
      // Fade labels with distance so large orgs don't drown in text.
      const d = camera.position.distanceTo(center);
      label.current.style.opacity = String(selected || hovered ? 1 : Math.max(0, Math.min(1, (420 - d) / 160)));
    }
  });

  return (
    <group position={position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          select(account.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover(account.id);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          hover(null);
          document.body.style.cursor = "";
        }}
      >
        <sphereGeometry args={[radius, 48, 48]} />
        <meshStandardMaterial
          color="#050a14"
          emissive={color}
          emissiveIntensity={suspended ? 0.1 : hovered || selected ? 0.9 : 0.45}
          roughness={0.6}
          metalness={0.3}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={wire} raycast={() => null}>
        <icosahedronGeometry args={[radius * 1.04, 2]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={suspended ? 0.15 : 0.5} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <sphereGeometry args={[radius * 1.35, 32, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.08} side={BackSide} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      {selected && (
        <group ref={halo} rotation-x={Math.PI / 2}>
          <mesh raycast={() => null}>
            <torusGeometry args={[radius * 1.8, 0.05, 8, 96]} />
            <meshBasicMaterial color={HUD_ACCENT} toneMapped={false} />
          </mesh>
          {[0, 1, 2, 3].map((i) => (
            <mesh key={i} position={[Math.cos((i * Math.PI) / 2) * radius * 1.8, Math.sin((i * Math.PI) / 2) * radius * 1.8, 0]} raycast={() => null}>
              <boxGeometry args={[0.3, 0.3, 0.3]} />
              <meshBasicMaterial color={HUD_ACCENT} toneMapped={false} />
            </mesh>
          ))}
        </group>
      )}
      <Html position={[0, -radius - 1.2, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div ref={label} className="whitespace-nowrap text-center font-mono uppercase">
          {/* By cost, a dim ramp step would make the name hard to read: text keeps a text colour. */}
          <div className="text-[11px] tracking-[0.2em]" style={{ color: colorBy === "cost" ? "#e2e8f0" : color }}>
            {account.name}
          </div>
          <div className="text-[9px] tracking-widest text-slate-400">
            {account.accountId} · {planet.resourceCount} res
            {spend && ` · ${spend}`}
          </div>
        </div>
      </Html>
    </group>
  );
}

function AccountArc({ arc }: { arc: Arc }) {
  const { org } = useSceneData();
  const from = org.planetById.get(arc.from)!;
  const to = org.planetById.get(arc.to)!;
  const color = EDGE_COLOR[arc.kind];

  const { start, mid, end, curve } = useMemo(() => {
    const start = new Vector3(...from.position);
    const end = new Vector3(...to.position);
    const mid = start.clone().lerp(end, 0.5);
    mid.y += start.distanceTo(end) * 0.25 + 6;
    return { start, mid, end, curve: new QuadraticBezierCurve3(start, mid, end) };
  }, [from.position, to.position]);

  return (
    <group>
      <QuadraticBezierLine start={start} end={end} mid={mid} color={color} lineWidth={1 + Math.log2(arc.count)} transparent opacity={0.45} />
      <Flow curve={curve} color={color} count={Math.min(6, 2 + arc.count)} speed={0.12} width={2 + Math.log2(arc.count)} />
    </group>
  );
}

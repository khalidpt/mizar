"use client";

import { CameraControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Scanline, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { useEffect, useRef, useState } from "react";
import { Vector2, Vector3 } from "three";
import { useSceneData } from "./data";
import { Hologram } from "./Hologram";
import { hologramTransform, type Planet } from "./layout";
import { OrgSystem } from "./OrgSystem";
import { useMizar } from "./store";
import { BACKGROUND } from "./theme";

/** Accounts within this camera distance unfold into holograms (semantic zoom). */
const HOLOGRAM_RANGE = 75;
const MAX_HOLOGRAMS = 3;

export default function Scene() {
  const effects = useMizar((s) => s.effects);
  return (
    <Canvas camera={{ fov: 50, near: 0.1, far: 8000, position: [0, 900, 1800] }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 600, 2400]} />
      <ambientLight intensity={0.25} />
      <Stars radius={1600} depth={400} count={7000} factor={7} saturation={0} fade speed={0.6} />
      <OrgSystem />
      <Holograms />
      <CameraRig />
      {effects && (
        <EffectComposer>
          <Bloom mipmapBlur luminanceThreshold={0.18} luminanceSmoothing={0.3} intensity={1.3} />
          <ChromaticAberration offset={new Vector2(0.0007, 0.0007)} radialModulation={false} modulationOffset={0} />
          <Scanline blendFunction={BlendFunction.OVERLAY} density={1.25} opacity={0.08} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.25} />
          <Vignette offset={0.25} darkness={0.75} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

/** Mounts holograms for the selected account plus the few nearest the camera. */
function Holograms() {
  const { org } = useSceneData();
  const selectedId = useMizar((s) => s.selectedId);
  const [nearby, setNearby] = useState<string[]>([]);
  const frame = useRef(0);
  const scratch = useRef(new Vector3());

  useFrame(({ camera }) => {
    if (frame.current++ % 15) return;
    const near = org.planets
      .map((p) => ({ id: p.account.id, d: camera.position.distanceTo(scratch.current.set(...p.position)) }))
      .filter((p) => p.d < HOLOGRAM_RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_HOLOGRAMS)
      .map((p) => p.id)
      .sort();
    if (near.join() !== nearby.join()) setNearby(near);
  });

  const selectedAccount = selectedId ? (org.planetById.has(selectedId) ? selectedId : org.accountNodeOf.get(selectedId)) : undefined;
  const ids = new Set(nearby);
  if (selectedAccount) ids.add(selectedAccount);

  return (
    <>
      {[...ids].map((id) => {
        const planet = org.planetById.get(id);
        return planet && <Hologram key={id} planet={planet} />;
      })}
    </>
  );
}

/** Flies the camera to whatever is selected; pulls back to the overview when nothing is. */
function CameraRig() {
  const controls = useRef<CameraControls>(null);
  const data = useSceneData();
  const selectedId = useMizar((s) => s.selectedId);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { org, index } = data;
    const node = selectedId ? index.byId.get(selectedId) : undefined;
    const accountNodeId = node && (org.planetById.has(node.id) ? node.id : org.accountNodeOf.get(node.id));
    const planet = accountNodeId ? org.planetById.get(accountNodeId) : undefined;

    if (!planet) {
      const r = org.extent;
      void c.setLookAt(0, r * 0.75 + 40, r * 1.5 + 60, 0, 0, 0, true);
      return;
    }

    // Approach from outside the system, so the glowing core sits behind the target.
    const outward = new Vector3(planet.position[0], 0, planet.position[2]).normalize();
    if (outward.lengthSq() === 0) outward.set(0, 0, 1);

    const isAccount = node!.id === planet.account.id;
    const world = data.worldPosition(node!.id);
    const target = isAccount || !world ? hologramCenter(planet, data) : new Vector3(...world);
    const distance = isAccount ? 26 : node!.type === "region" || node!.type === "vpc" ? 16 : 9;
    const eye = target.clone().addScaledVector(outward, distance).add(new Vector3(0, distance * 0.45, 0));
    void c.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, true);
  }, [selectedId, data]);

  return <CameraControls ref={controls} makeDefault smoothTime={0.6} minDistance={2} maxDistance={4000} />;
}

function hologramCenter(planet: Planet, data: ReturnType<typeof useSceneData>): Vector3 {
  const holo = data.hologram(planet.account.id);
  const { origin, scale } = hologramTransform(planet, holo);
  return new Vector3(origin[0], origin[1] + (holo.height * scale) / 2, origin[2]);
}

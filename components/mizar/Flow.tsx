"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Vector3, type Curve, type Group, type PerspectiveCamera } from "three";

const UP = new Vector3(0, 1, 0);

/**
 * Thin pulses travelling along a curve. Sized in screen pixels (like drei's `Line` widths), so they stay a hair
 * wider than the line they ride on at any zoom, and stretched along the curve's tangent so they read as streaks.
 */
export function Flow({
  curve,
  color,
  count = 3,
  speed = 0.25,
  width = 2,
  length = 10,
}: {
  curve: Curve<Vector3>;
  color: string;
  count?: number;
  speed?: number;
  /** Pulse thickness in pixels; pass the line's `lineWidth` + 1. */
  width?: number;
  /** Pulse length in pixels. */
  length?: number;
}) {
  const group = useRef<Group>(null);
  const scratch = useRef({ tangent: new Vector3(), world: new Vector3(), parentScale: new Vector3() });

  useFrame(({ clock, camera, size }) => {
    const g = group.current;
    if (!g) return;
    const { tangent, world, parentScale } = scratch.current;
    // World units per screen pixel at distance 1, undoing any scale on enclosing groups (holograms are shrunk).
    const unitsPerPixel = (2 * Math.tan(((camera as PerspectiveCamera).fov * Math.PI) / 360)) / size.height / g.getWorldScale(parentScale).x;

    g.children.forEach((child, i) => {
      const t = (clock.elapsedTime * speed + i / count) % 1;
      curve.getPointAt(t, child.position);
      child.quaternion.setFromUnitVectors(UP, curve.getTangentAt(t, tangent));
      const k = unitsPerPixel * camera.position.distanceTo(child.getWorldPosition(world));
      // The unit capsule is 1 wide and 2 tall (body 1 + two 0.5 caps).
      child.scale.set(width * k, (length / 2) * k, width * k);
    });
  });

  return (
    <group ref={group}>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} raycast={() => null}>
          <capsuleGeometry args={[0.5, 1, 4, 8]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

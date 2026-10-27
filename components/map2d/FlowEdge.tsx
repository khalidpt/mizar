"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import type { EdgeKind } from "@/lib/graph/types";
import { useMizar } from "@/components/mizar/store";
import { EDGE_COLOR } from "@/components/mizar/theme";

export type RelationEdge = Edge<{ kind: EdgeKind; count: number; animate: boolean }>;

/** Midpoint of the side of `node` that faces `other`, so lines never loop around boxes. */
function anchor(node: InternalNode, other: InternalNode): { x: number; y: number; position: Position } {
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const o = other.internals.positionAbsolute;
  const dx = o.x + (other.measured.width ?? 0) / 2 - (x + w / 2);
  const dy = o.y + (other.measured.height ?? 0) / 2 - (y + h / 2);
  // Compare against the box's aspect so wide cards still prefer left/right for sideways neighbours.
  if (Math.abs(dx) / Math.max(w, 1) >= Math.abs(dy) / Math.max(h, 1)) {
    return dx > 0 ? { x: x + w, y: y + h / 2, position: Position.Right } : { x, y: y + h / 2, position: Position.Left };
  }
  return dy > 0 ? { x: x + w / 2, y: y + h, position: Position.Bottom } : { x: x + w / 2, y, position: Position.Top };
}

/** Relationship line with a travelling pulse; brightens when either end is selected, dims otherwise. */
export function FlowEdge({ id, source, target, data }: EdgeProps<RelationEdge>) {
  const focus = useMizar((s) => s.selectedId);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const { kind, count, animate } = data!;
  const color = EDGE_COLOR[kind];
  const active = focus === source || focus === target;
  const dimmed = focus !== null && !active;
  if (!sourceNode || !targetNode) return null;
  const s = anchor(sourceNode, targetNode);
  const t = anchor(targetNode, sourceNode);
  const strokeWidth = (active ? 2 : 1.2) + Math.log2(count) * 0.8;
  const [path, labelX, labelY] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: s.position,
    targetX: t.x,
    targetY: t.y,
    targetPosition: t.position,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth,
          opacity: dimmed ? 0.12 : active ? 1 : 0.55,
          filter: active ? `drop-shadow(0 0 4px ${color})` : undefined,
        }}
      />
      {animate && !dimmed && (
        // A short streak just wider than the line, turned to follow the curve.
        <rect x={-5} y={-(strokeWidth + 1) / 2} width={10} height={strokeWidth + 1} rx={(strokeWidth + 1) / 2} fill={color}>
          <animateMotion dur={`${active ? 1.6 : 3.2}s`} repeatCount="indefinite" path={path} rotate="auto" />
        </rect>
      )}
      {count > 1 && !dimmed && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute border bg-slate-950/90 px-1 font-mono text-[9px]"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color, borderColor: `${color}66` }}
          >
            ×{count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

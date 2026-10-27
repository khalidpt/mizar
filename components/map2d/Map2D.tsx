"use client";

import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { useSceneData } from "@/components/mizar/data";
import { useMizar } from "@/components/mizar/store";
import { accountColor } from "@/components/mizar/cost";
import { BACKGROUND, TYPE_COLOR } from "@/components/mizar/theme";
import type { Environment } from "@/lib/graph/types";
import { FlowEdge, type RelationEdge } from "./FlowEdge";
import { absoluteRect, layoutFlat, type FlatLayout } from "./layout2d";
import { CardNode, ContainerNode, ResourceNode, ServicesNode, type BoxNode } from "./nodes";

const nodeTypes = { container: ContainerNode, card: CardNode, resource: ResourceNode, services: ServicesNode };
const edgeTypes = { flow: FlowEdge };
/** Travelling pulses are SVG animations; skip them when there are too many lines on screen. */
const ANIMATED_EDGE_LIMIT = 300;
/** Screen space the HUD panels cover; framing keeps content clear of them. */
const HUD_INSETS = { top: 72, bottom: 72, left: 352, right: 24 };
const DETAILS_PANEL_INSET = 416;
const MAX_FOCUS_ZOOM = 1.6;

export default function Map2D() {
  return (
    <ReactFlowProvider>
      <FlatMap />
    </ReactFlowProvider>
  );
}

function FlatMap() {
  const { index, org, cost } = useSceneData();
  const colorBy = useMizar((s) => s.colorBy);
  const expanded = useMizar((s) => s.expanded);
  const hiddenEdgeKinds = useMizar((s) => s.hiddenEdgeKinds);
  const selectedId = useMizar((s) => s.selectedId);
  const select = useMizar((s) => s.select);
  const hover = useMizar((s) => s.hover);
  const toggleExpanded = useMizar((s) => s.toggleExpanded);
  const { setViewport } = useReactFlow();
  const viewportWidth = useStore((s) => s.width);
  const viewportHeight = useStore((s) => s.height);
  const [layout, setLayout] = useState<FlatLayout | null>(null);

  useEffect(() => {
    let cancelled = false;
    void layoutFlat(index, expanded).then((next) => {
      if (!cancelled) setLayout(next);
    });
    return () => {
      cancelled = true;
    };
  }, [index, expanded]);

  // Whatever gets selected (search, deep link, 3D) must be visible: open its account.
  useEffect(() => {
    const account = selectedId ? org.accountNodeOf.get(selectedId) : undefined;
    if (account && account !== selectedId && !expanded.has(account)) toggleExpanded(account);
  }, [selectedId, org, expanded, toggleExpanded]);

  const nodes = useMemo<BoxNode[]>(
    () =>
      (layout?.boxes ?? []).map((box) => ({
        id: box.id,
        type: box.kind,
        position: { x: box.x, y: box.y },
        parentId: box.parentId,
        width: box.w,
        height: box.h,
        style: { width: box.w, height: box.h },
        data: { box },
        draggable: false,
        connectable: false,
      })),
    [layout],
  );

  const edges = useMemo<RelationEdge[]>(() => {
    const shown = (layout?.edges ?? []).filter((e) => !hiddenEdgeKinds.has(e.kind));
    return shown.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "flow",
      data: { kind: e.kind, count: e.count, animate: shown.length <= ANIMATED_EDGE_LIMIT },
    }));
  }, [layout, hiddenEdgeKinds]);

  // Frame the selection (or everything) whenever it or the layout changes, keeping clear of the HUD panels.
  // Computed from the layout's own geometry: React Flow never measures off-screen nodes
  // (onlyRenderVisibleElements), so its fitView can't be relied on here.
  useEffect(() => {
    if (!layout || !viewportWidth || !viewportHeight) return;
    const rect = (selectedId && absoluteRect(layout.boxes, selectedId)) || absoluteRect(layout.boxes, layout.boxes[0].id);
    if (!rect) return;
    const inset = { ...HUD_INSETS, right: selectedId ? DETAILS_PANEL_INSET : HUD_INSETS.right };
    const availableW = Math.max(viewportWidth - inset.left - inset.right, 100);
    const availableH = Math.max(viewportHeight - inset.top - inset.bottom, 100);
    const zoom = Math.min(availableW / rect.width, availableH / rect.height, MAX_FOCUS_ZOOM);
    void setViewport(
      {
        x: inset.left + (availableW - rect.width * zoom) / 2 - rect.x * zoom,
        y: inset.top + (availableH - rect.height * zoom) / 2 - rect.y * zoom,
        zoom,
      },
      { duration: 700 },
    );
  }, [selectedId, layout, setViewport, viewportWidth, viewportHeight]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      minZoom={0.02}
      maxZoom={3}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onlyRenderVisibleElements
      onNodeClick={(_, n) => n.data.box.node && select(n.id)}
      onNodeDoubleClick={(_, n) => n.data.box.node?.type === "account" && toggleExpanded(n.id)}
      onNodeMouseEnter={(_, n) => n.data.box.node && hover(n.id)}
      onNodeMouseLeave={() => hover(null)}
      style={{ background: BACKGROUND }}
    >
      <Background id="major" variant={BackgroundVariant.Lines} gap={120} color="rgba(94, 234, 212, 0.06)" />
      <Background id="minor" variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(94, 234, 212, 0.12)" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        bgColor="#050a14"
        maskColor="rgba(2, 4, 11, 0.7)"
        maskStrokeColor="#5eead4"
        nodeColor={(n) => {
          const node = (n as BoxNode).data.box.node;
          if (!node) return "transparent";
          if (node.type === "account") return accountColor(node, (node.tags.Environment as Environment) ?? "shared", colorBy, cost);
          return node.type === "organization" || node.type === "ou" ? "rgba(94, 234, 212, 0.08)" : TYPE_COLOR[node.type];
        }}
        style={{ border: "1px solid rgba(94, 234, 212, 0.25)" }}
      />
    </ReactFlow>
  );
}

"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { indexGraph, type GraphIndex } from "@/lib/graph/query";
import type { InfraGraph } from "@/lib/graph/types";
import { type CostScale, costScale } from "./cost";
import { hologramTransform, layoutHologram, layoutOrg, toWorld, type Hologram, type OrgLayout, type Vec3 } from "./layout";

export interface SceneData {
  graph: InfraGraph;
  index: GraphIndex;
  org: OrgLayout;
  /** Null when the snapshot has no cost figures (not collected, or hidden by the server). */
  cost: CostScale | null;
  /** Memoized per account node id. */
  hologram: (accountNodeId: string) => Hologram;
  /** World position of any node that is drawn (org core, planets, hologram contents); null for OUs. */
  worldPosition: (nodeId: string) => Vec3 | null;
}

const SceneDataContext = createContext<SceneData | null>(null);

export function SceneDataProvider({ graph, children }: { graph: InfraGraph; children: ReactNode }) {
  const value = useMemo<SceneData>(() => {
    const index = indexGraph(graph);
    const org = layoutOrg(graph, index);
    const holograms = new Map<string, Hologram>();
    const hologram = (accountNodeId: string) => {
      let holo = holograms.get(accountNodeId);
      if (!holo) {
        holo = layoutHologram(index, accountNodeId);
        holograms.set(accountNodeId, holo);
      }
      return holo;
    };
    const worldPosition = (nodeId: string): Vec3 | null => {
      if (nodeId === index.root.id) return [0, 0, 0];
      const planet = org.planetById.get(nodeId);
      if (planet) return planet.position;
      const accountNodeId = org.accountNodeOf.get(nodeId);
      if (!accountNodeId) return null;
      const holo = hologram(accountNodeId);
      const local = holo.positionOf.get(nodeId);
      if (!local) return null;
      const { origin, scale } = hologramTransform(org.planetById.get(accountNodeId)!, holo);
      return toWorld(origin, scale, local);
    };
    return { graph, index, org, cost: costScale(graph, index.root), hologram, worldPosition };
  }, [graph]);

  return <SceneDataContext.Provider value={value}>{children}</SceneDataContext.Provider>;
}

export function useSceneData(): SceneData {
  const value = useContext(SceneDataContext);
  if (!value) throw new Error("useSceneData must be used inside SceneDataProvider");
  return value;
}

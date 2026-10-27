import { create } from "zustand";
import type { EdgeKind } from "@/lib/graph/types";
import type { ColorBy } from "./cost";

export type ViewMode = "3d" | "2d";

interface MizarState {
  /** Selected node (any type); drives the details panel, camera / viewport focus and the `#<id>` deep link. */
  selectedId: string | null;
  hoveredId: string | null;
  /** Null until read from the URL after mount, so server and first client render agree. */
  view: ViewMode | null;
  /** 3D post-processing on/off. */
  effects: boolean;
  /** What account colour means in both views: environment, or spend (only offered when the snapshot has costs). */
  colorBy: ColorBy;
  /** Relationship kinds hidden in both views. */
  hiddenEdgeKinds: ReadonlySet<EdgeKind>;
  /** 2D: account node ids shown in full detail rather than as a card. */
  expanded: ReadonlySet<string>;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  setView: (view: ViewMode) => void;
  toggleEffects: () => void;
  setColorBy: (colorBy: ColorBy) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
  toggleExpanded: (accountNodeId: string) => void;
  setExpanded: (accountNodeIds: Iterable<string>) => void;
}

const toggled = <T>(set: ReadonlySet<T>, item: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
};

export const useMizar = create<MizarState>((set) => ({
  selectedId: null,
  hoveredId: null,
  view: null,
  effects: true,
  colorBy: "environment",
  hiddenEdgeKinds: new Set(),
  expanded: new Set(),
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  setView: (view) => set({ view, hoveredId: null }),
  toggleEffects: () => set((s) => ({ effects: !s.effects })),
  setColorBy: (colorBy) => set({ colorBy }),
  toggleEdgeKind: (kind) => set((s) => ({ hiddenEdgeKinds: toggled(s.hiddenEdgeKinds, kind) })),
  toggleExpanded: (id) => set((s) => ({ expanded: toggled(s.expanded, id) })),
  setExpanded: (ids) => set({ expanded: new Set(ids) }),
}));

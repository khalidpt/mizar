import { checkSnapshot } from "@/lib/graph/schema";
import type { InfraGraph } from "@/lib/graph/types";

export interface SnapshotMeta {
  /** Sortable id; lexical order is chronological order. */
  id: string;
  generatedAt: string;
  /** Serialized size, when the backend knows it cheaply. */
  bytes?: number;
}

/** Where collectors write snapshots and the web app reads them. One implementation per `MIZAR_STORE` scheme. */
export interface SnapshotStore {
  /** Persists a snapshot and prunes beyond the retention limit. */
  save(graph: InfraGraph): Promise<SnapshotMeta>;
  /** Most recent first. */
  list(limit?: number): Promise<SnapshotMeta[]>;
  get(id: string): Promise<InfraGraph | null>;
  latest(): Promise<InfraGraph | null>;
}

/** `2026-10-16T12:00:00.000Z` → `2026-10-16T12-00-00-000Z`: filesystem- and key-safe, still sortable. */
export function snapshotId(generatedAt: string): string {
  return new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
}

const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;

export function isSnapshotId(id: string): boolean {
  return SNAPSHOT_ID.test(id);
}

/** Inverse of `snapshotId`, ignoring any collision suffix. */
export function generatedAtOf(id: string): string {
  return id.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*$/, "T$1:$2:$3.$4Z");
}

/** Chronological, with same-millisecond suffixes (`-2`, `-10`) in numeric order. */
export function compareIds(a: string, b: string): number {
  const parse = (id: string) => {
    const [, base, n] = /^(.*Z)(?:-(\d+))?$/.exec(id)!;
    return { base, n: Number(n ?? 1) };
  };
  const pa = parse(a);
  const pb = parse(b);
  return pa.base === pb.base ? pa.n - pb.n : pa.base < pb.base ? -1 : 1;
}

/**
 * The snapshot contract, checked on every read too (a few ms for thousands of nodes): stores may be written by
 * other collectors, and a bad snapshot should fail here with a reason rather than in the renderers.
 */
export function assertSnapshot(value: unknown, id: string): InfraGraph {
  const errors = checkSnapshot(value);
  if (errors.length) {
    throw new Error(`Snapshot ${id} is not a valid version 1 InfraGraph (${errors.length} problems):\n  ${errors.slice(0, 5).join("\n  ")}`);
  }
  return value as InfraGraph;
}

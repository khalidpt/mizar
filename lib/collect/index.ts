import type { MizarConfig } from "@/lib/config";
import { generateMockGraph } from "@/lib/graph/mock";
import { checkSnapshot } from "@/lib/graph/schema";
import type { InfraGraph } from "@/lib/graph/types";
import type { SnapshotMeta, SnapshotStore } from "@/lib/store";

export interface CollectContext {
  /** Progress and warnings, one line each. */
  log(message: string): void;
}

/** Produces one complete snapshot of the infrastructure. One implementation per `config.source`. */
export interface Collector {
  readonly name: string;
  collect(context: CollectContext): Promise<InfraGraph>;
}

export function createCollector(config: MizarConfig): Collector {
  switch (config.source) {
    case "mock":
      return {
        name: "mock",
        collect: async () => generateMockGraph({ ...config.mock, generatedAt: new Date().toISOString() }),
      };
    case "aws":
      return {
        name: "aws",
        // Loaded on demand: the AWS SDK is only needed when collecting from AWS.
        collect: async (context) => new (await import("./aws")).AwsCollector(config.aws).collect(context),
      };
  }
}

export interface CollectResult {
  meta: SnapshotMeta;
  nodes: number;
  edges: number;
  durationMs: number;
}

/** Collect, validate, save. Invalid graphs are never written. */
export async function collectOnce(
  config: MizarConfig,
  store: SnapshotStore,
  context: CollectContext = { log: () => {} },
): Promise<CollectResult> {
  const started = Date.now();
  const graph = await createCollector(config).collect(context);
  const errors = checkSnapshot(graph);
  if (errors.length) {
    throw new Error(`Collector "${config.source}" produced an invalid graph (${errors.length} problems):\n  ${errors.slice(0, 10).join("\n  ")}`);
  }
  const meta = await store.save(graph);
  return { meta, nodes: graph.nodes.length, edges: graph.edges.length, durationMs: Date.now() - started };
}

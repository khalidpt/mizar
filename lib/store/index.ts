import { redactUrl, type MizarConfig } from "@/lib/config";
import { FileStore } from "./file";
import type { SnapshotStore } from "./types";

export type { SnapshotMeta, SnapshotStore } from "./types";

const PLANNED = new Set(["sqlite", "postgres", "postgresql"]);

/** Opens the store named by `config.store`: `file://<dir>`, a bare path, or `s3://<bucket>[/<prefix>]`. */
export function openStore(config: Pick<MizarConfig, "store" | "retain">): SnapshotStore {
  const url = config.store;
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(url)?.[1]?.toLowerCase();

  if (!scheme) return new FileStore(url, config.retain);
  if (scheme === "file") return new FileStore(url.slice("file://".length), config.retain);
  if (scheme === "s3") {
    const location = parseS3Url(url);
    // Loaded on demand: the AWS SDK is only needed for an S3 store.
    return lazyStore(async () => new (await import("./s3")).S3Store(location, config.retain));
  }
  if (PLANNED.has(scheme)) throw new Error(`Snapshot store "${scheme}://" is planned but not implemented yet (${redactUrl(url)})`);
  throw new Error(`Unknown snapshot store scheme "${scheme}://" in ${redactUrl(url)}`);
}

export interface S3Location {
  bucket: string;
  /** Key prefix without leading or trailing slashes; empty for the bucket root. */
  prefix: string;
  /** Bucket region; defaults to the SDK's, and requests to the wrong region are redirected. */
  region?: string;
  /** S3-compatible endpoint (MinIO, LocalStack); implies path-style addressing. */
  endpoint?: string;
}

/**
 * `s3://<bucket>[/<prefix>][?region=<region>&endpoint=<url>]`. Credentials never go in the URL: like the
 * collector, the store uses the SDK default provider chain.
 */
export function parseS3Url(url: string): S3Location {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid S3 store URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("S3 store URLs must not contain credentials; Mizar uses the AWS SDK default provider chain");
  }
  const bucket = parsed.hostname;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`Invalid S3 bucket name "${bucket}" in ${url}`);
  for (const key of parsed.searchParams.keys()) {
    if (key !== "region" && key !== "endpoint") throw new Error(`Unknown S3 store option "${key}" (expected region, endpoint)`);
  }
  return {
    bucket,
    prefix: decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, ""),
    region: parsed.searchParams.get("region") || undefined,
    endpoint: parsed.searchParams.get("endpoint") || undefined,
  };
}

function lazyStore(load: () => Promise<SnapshotStore>): SnapshotStore {
  let store: Promise<SnapshotStore> | undefined;
  const open = () => (store ??= load().catch((error) => ((store = undefined), Promise.reject(error))));
  return {
    save: async (graph) => (await open()).save(graph),
    list: async (limit) => (await open()).list(limit),
    get: async (id) => (await open()).get(id),
    latest: async () => (await open()).latest(),
  };
}

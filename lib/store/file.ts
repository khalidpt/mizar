import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { InfraGraph } from "@/lib/graph/types";
import {
  assertSnapshot,
  compareIds,
  generatedAtOf,
  isSnapshotId,
  snapshotId,
  type SnapshotMeta,
  type SnapshotStore,
} from "./types";

/** One JSON file per snapshot in a directory. Zero dependencies; the default store. */
export class FileStore implements SnapshotStore {
  private readonly dir: string;

  constructor(
    dir: string,
    private readonly retain: number,
  ) {
    // Runtime user directory, not code: every path below is kept out of Next's output file tracing.
    this.dir = resolve(/*turbopackIgnore: true*/ dir);
  }

  async save(graph: InfraGraph): Promise<SnapshotMeta> {
    await mkdir(/*turbopackIgnore: true*/ this.dir, { recursive: true });
    const base = snapshotId(graph.generatedAt);
    const existing = new Set(await this.ids());
    let id = base;
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;

    // Write then rename, so readers never see a half-written snapshot.
    const body = JSON.stringify(graph);
    const tmp = join(/*turbopackIgnore: true*/ this.dir, `.${id}.tmp`);
    await writeFile(/*turbopackIgnore: true*/ tmp, body, "utf8");
    await rename(/*turbopackIgnore: true*/ tmp, /*turbopackIgnore: true*/ this.path(id));
    await this.prune();
    return { id, generatedAt: graph.generatedAt, bytes: Buffer.byteLength(body) };
  }

  async list(limit = Infinity): Promise<SnapshotMeta[]> {
    const ids = (await this.ids()).slice(0, limit);
    return Promise.all(
      ids.map(async (id) => ({
        id,
        generatedAt: generatedAtOf(id),
        bytes: (await stat(/*turbopackIgnore: true*/ this.path(id))).size,
      })),
    );
  }

  async get(id: string): Promise<InfraGraph | null> {
    if (!isSnapshotId(id)) return null;
    try {
      return assertSnapshot(JSON.parse(await readFile(/*turbopackIgnore: true*/ this.path(id), "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async latest(): Promise<InfraGraph | null> {
    const [newest] = await this.ids();
    return newest ? this.get(newest) : null;
  }

  private path(id: string): string {
    return join(/*turbopackIgnore: true*/ this.dir, `${id}.json`);
  }

  /** Snapshot ids, newest first. */
  private async ids(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(/*turbopackIgnore: true*/ this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter(isSnapshotId)
      .sort(compareIds)
      .reverse();
  }

  private async prune(): Promise<void> {
    const stale = (await this.ids()).slice(this.retain);
    await Promise.all(stale.map((id) => unlink(/*turbopackIgnore: true*/ this.path(id)).catch(() => undefined)));
  }
}

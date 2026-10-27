import {
  DeleteObjectCommand,
  GetObjectCommand,
  type ListObjectsV2CommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { InfraGraph } from "@/lib/graph/types";
import type { S3Location } from ".";
import {
  assertSnapshot,
  compareIds,
  generatedAtOf,
  isSnapshotId,
  snapshotId,
  type SnapshotMeta,
  type SnapshotStore,
} from "./types";

export function s3Client(location: S3Location): S3Client {
  return new S3Client({
    region: location.region,
    endpoint: location.endpoint,
    forcePathStyle: Boolean(location.endpoint),
    followRegionRedirects: true,
    maxAttempts: 5,
  });
}

/**
 * One `<prefix>/<id>.json` object per snapshot. S3 never exposes a partly written object, and conditional writes
 * (`If-None-Match: *`) keep two collectors from overwriting each other's snapshot with the same id.
 */
export class S3Store implements SnapshotStore {
  constructor(
    private readonly location: S3Location,
    private readonly retain: number,
    private readonly client: S3Client = s3Client(location),
  ) {}

  async save(graph: InfraGraph): Promise<SnapshotMeta> {
    const base = snapshotId(graph.generatedAt);
    const existing = new Set((await this.objects()).map((o) => o.id));
    const body = JSON.stringify(graph);
    let n = 1;
    for (let attempt = 0; ; attempt++) {
      while (existing.has(n === 1 ? base : `${base}-${n}`)) n++;
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.location.bucket,
            Key: this.key(id),
            Body: body,
            ContentType: "application/json",
            IfNoneMatch: "*",
          }),
        );
        await this.prune();
        return { id, generatedAt: graph.generatedAt, bytes: Buffer.byteLength(body) };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        // 412: the id was taken since we listed; 409: a concurrent conditional write to it is in flight.
        if ((status !== 412 && status !== 409) || attempt >= 10) throw error;
        existing.add(id);
      }
    }
  }

  async list(limit = Infinity): Promise<SnapshotMeta[]> {
    return (await this.objects())
      .slice(0, limit)
      .map(({ id, bytes }) => ({ id, generatedAt: generatedAtOf(id), bytes }));
  }

  async get(id: string): Promise<InfraGraph | null> {
    if (!isSnapshotId(id)) return null;
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: this.key(id) }));
      return assertSnapshot(JSON.parse(await object.Body!.transformToString("utf8")), id);
    } catch (error) {
      if ((error as Error).name === "NoSuchKey") return null;
      throw error;
    }
  }

  async latest(): Promise<InfraGraph | null> {
    const [newest] = await this.objects();
    return newest ? this.get(newest.id) : null;
  }

  private key(id: string): string {
    return this.location.prefix ? `${this.location.prefix}/${id}.json` : `${id}.json`;
  }

  /** Snapshot objects directly under the prefix, newest first. */
  private async objects(): Promise<{ id: string; bytes?: number }[]> {
    const prefix = this.location.prefix ? `${this.location.prefix}/` : "";
    const found: { id: string; bytes?: number }[] = [];
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.location.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key!.slice(prefix.length);
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (isSnapshotId(id)) found.push({ id, bytes: object.Size });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return found.sort((a, b) => compareIds(b.id, a.id));
  }

  private async prune(): Promise<void> {
    const stale = (await this.objects()).slice(this.retain);
    await Promise.all(
      stale.map(({ id }) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.location.bucket, Key: this.key(id) })).catch(() => undefined),
      ),
    );
  }
}

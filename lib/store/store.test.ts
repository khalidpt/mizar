import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { generateMockGraph } from "@/lib/graph/mock";
import type { InfraGraph } from "@/lib/graph/types";
import { FileStore } from "./file";
import { openStore, parseS3Url, type S3Location } from ".";
import { S3Store, s3Client } from "./s3";
import type { SnapshotStore } from "./types";

const graph = (generatedAt: string): InfraGraph => ({ ...generateMockGraph({ teams: 1, sandboxes: 0 }), generatedAt });

/** A real S3Client whose `send` is an in-memory bucket. `steal` simulates another writer taking a key first. */
function fakeS3(location: S3Location, options: { pageSize?: number; steal?: Set<string> } = {}) {
  const objects = new Map<string, string>();
  const client = s3Client({ ...location, region: "us-east-1" });
  const error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  (client as unknown as { send: (cmd: { input: Record<string, never> }) => Promise<unknown> }).send = async (cmd) => {
    const input = cmd.input as Record<string, string | undefined>;
    assert.equal(input.Bucket, location.bucket);
    switch (cmd.constructor.name) {
      case "PutObjectCommand":
        if (options.steal?.delete(input.Key!)) objects.set(input.Key!, "{}");
        if (input.IfNoneMatch === "*" && objects.has(input.Key!)) throw error("PreconditionFailed", 412);
        objects.set(input.Key!, input.Body!);
        return {};
      case "GetObjectCommand": {
        const body = objects.get(input.Key!);
        if (body === undefined) throw error("NoSuchKey", 404);
        return { Body: { transformToString: async () => body } };
      }
      case "DeleteObjectCommand":
        objects.delete(input.Key!);
        return {};
      case "ListObjectsV2Command": {
        // Like S3 with a delimiter: keys in nested "folders" are not listed.
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(input.Prefix ?? "") && !k.slice((input.Prefix ?? "").length).includes("/"))
          .sort();
        const start = Number(input.ContinuationToken ?? 0);
        const size = options.pageSize ?? 1000;
        const page = keys.slice(start, start + size);
        const more = start + size < keys.length;
        return {
          Contents: page.map((Key) => ({ Key, Size: Buffer.byteLength(objects.get(Key)!) })),
          IsTruncated: more,
          NextContinuationToken: more ? String(start + size) : undefined,
        };
      }
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  };
  return { client, objects };
}

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const backends: Record<string, (retain: number) => Promise<SnapshotStore>> = {
  file: async (retain) => {
    const dir = await mkdtemp(join(tmpdir(), "mizar-store-"));
    dirs.push(dir);
    return new FileStore(dir, retain);
  },
  s3: async (retain) => {
    const location = { bucket: "mizar-test", prefix: "snapshots" };
    return new S3Store(location, retain, fakeS3(location, { pageSize: 2 }).client);
  },
};

for (const [name, open] of Object.entries(backends)) {
  describe(`${name} store`, () => {
    test("is empty before the first save", async () => {
      const store = await open(5);
      assert.equal(await store.latest(), null);
      assert.deepEqual(await store.list(), []);
    });

    test("saves, lists newest first and reads back", async () => {
      const store = await open(5);
      const first = await store.save(graph("2026-10-16T12:00:00.000Z"));
      const second = await store.save(graph("2026-10-16T13:00:00.000Z"));
      assert.equal(first.id, "2026-10-16T12-00-00-000Z");
      const list = await store.list();
      assert.deepEqual(list.map((m) => m.id), [second.id, first.id]);
      assert.equal(list[0].generatedAt, "2026-10-16T13:00:00.000Z");
      assert.equal(list[0].bytes, second.bytes);
      assert.equal((await store.latest())?.generatedAt, "2026-10-16T13:00:00.000Z");
      assert.deepEqual(await store.get(first.id), graph("2026-10-16T12:00:00.000Z"));
      assert.equal((await store.list(1)).length, 1);
    });

    test("suffixes ids that collide, in numeric order", async () => {
      const store = await open(20);
      const at = "2026-10-16T12:00:00.000Z";
      const ids = [];
      for (let i = 0; i < 11; i++) ids.push((await store.save(graph(at))).id);
      assert.equal(ids[1], "2026-10-16T12-00-00-000Z-2");
      assert.deepEqual((await store.list()).map((m) => m.id), ids.toReversed());
    });

    test("prunes beyond the retention limit", async () => {
      const store = await open(2);
      for (const hour of ["10", "11", "12"]) await store.save(graph(`2026-10-16T${hour}:00:00.000Z`));
      assert.deepEqual((await store.list()).map((m) => m.generatedAt), ["2026-10-16T12:00:00.000Z", "2026-10-16T11:00:00.000Z"]);
    });

    test("never reads outside the store", async () => {
      const store = await open(5);
      assert.equal(await store.get("../etc/passwd"), null);
      assert.equal(await store.get("2026-10-16T12-00-00-000Z"), null);
    });
  });
}

describe("S3 store", () => {
  test("parses bucket, prefix and options from the URL", () => {
    assert.deepEqual(parseS3Url("s3://my-bucket"), { bucket: "my-bucket", prefix: "", region: undefined, endpoint: undefined });
    assert.deepEqual(parseS3Url("s3://my-bucket/mizar/prod/?region=eu-west-1&endpoint=http://localhost:9000"), {
      bucket: "my-bucket",
      prefix: "mizar/prod",
      region: "eu-west-1",
      endpoint: "http://localhost:9000",
    });
    assert.throws(() => parseS3Url("s3://key:secret@my-bucket"), /must not contain credentials/);
    assert.throws(() => parseS3Url("s3://My_Bucket"), /Invalid S3 bucket name/);
    assert.throws(() => parseS3Url("s3://my-bucket?sse=kms"), /Unknown S3 store option "sse"/);
  });

  test("openStore validates the URL up front", () => {
    assert.throws(() => openStore({ store: "s3://x", retain: 1 }), /Invalid S3 bucket name/);
    assert.ok(openStore({ store: "s3://my-bucket/prefix", retain: 1 }));
  });

  test("takes the next id when another writer wins the race", async () => {
    const location = { bucket: "mizar-test", prefix: "" };
    const steal = new Set(["2026-10-16T12-00-00-000Z.json"]);
    const { client, objects } = fakeS3(location, { steal });
    const meta = await new S3Store(location, 5, client).save(graph("2026-10-16T12:00:00.000Z"));
    assert.equal(meta.id, "2026-10-16T12-00-00-000Z-2");
    assert.deepEqual([...objects.keys()].sort(), ["2026-10-16T12-00-00-000Z-2.json", "2026-10-16T12-00-00-000Z.json"]);
  });

  test("ignores objects that aren't snapshots and nested prefixes", async () => {
    const location = { bucket: "mizar-test", prefix: "snapshots" };
    const { client, objects } = fakeS3(location);
    const store = new S3Store(location, 1, client);
    objects.set("snapshots/README.txt", "hi");
    objects.set("snapshots/archive/2026-10-16T09-00-00-000Z.json", "{}");
    objects.set("other/2026-10-16T09-00-00-000Z.json", "{}");
    await store.save(graph("2026-10-16T12:00:00.000Z"));
    await store.save(graph("2026-10-16T13:00:00.000Z"));
    assert.deepEqual([...objects.keys()].sort(), [
      "other/2026-10-16T09-00-00-000Z.json",
      "snapshots/2026-10-16T13-00-00-000Z.json",
      "snapshots/README.txt",
      "snapshots/archive/2026-10-16T09-00-00-000Z.json",
    ]);
  });
});

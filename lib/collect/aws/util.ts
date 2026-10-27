import type { Environment } from "@/lib/graph/types";

/** Runs `fn` over `items` with at most `concurrency` in flight. Results keep input order. */
export async function pool<T, R>(concurrency: number, items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Drains an SDK v3 paginator into one array. */
export async function all<Page, Item>(pages: AsyncIterable<Page>, pick: (page: Page) => Item[] | undefined): Promise<Item[]> {
  const out: Item[] = [];
  for await (const page of pages) out.push(...(pick(page) ?? []));
  return out;
}

/**
 * For services not offered in every region (WorkSpaces, Network Firewall): their endpoint hostname doesn't resolve
 * there, which means there is nothing to collect rather than a failure.
 */
export async function whereOffered<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOTFOUND") return undefined;
    throw error;
  }
}

/** Drains a `NextToken`-paged API that has no SDK paginator (API Gateway v2). */
export async function pages<Response extends { NextToken?: string }, Item>(
  request: (nextToken: string | undefined) => Promise<Response>,
  pick: (response: Response) => Item[] | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let token: string | undefined;
  do {
    const response = await request(token);
    out.push(...(pick(response) ?? []));
    token = response.NextToken;
  } while (token);
  return out;
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Tag = { Key?: string; Value?: string } | { key?: string; value?: string };

/** EC2-style `[{ Key, Value }]` (or ECS-style lowercase) → record. */
export function tagRecord(tags: readonly Tag[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags ?? []) {
    const key = "Key" in tag ? tag.Key : "key" in tag ? tag.key : undefined;
    const value = "Value" in tag ? tag.Value : "value" in tag ? tag.value : undefined;
    if (key) out[key] = value ?? "";
  }
  return out;
}

export function arn(partition: string, service: string, region: string, account: string, resource: string): string {
  return `arn:${partition}:${service}:${region}:${account}:${resource}`;
}

/** Short, single-line description of an SDK error, safe for logs and node metadata. */
export function describeError(error: unknown): string {
  const e = error as { name?: string; message?: string };
  const text = `${e?.name && e.name !== "Error" ? `${e.name}: ` : ""}${e?.message ?? String(error)}`;
  return text.replace(/\s+/g, " ").slice(0, 300);
}

const ENV_TAG_KEYS = ["environment", "env", "stage"];
const word = (alternatives: string) => new RegExp(`(^|[^a-z])(${alternatives})([^a-z]|$)`);
const ENV_PATTERNS: [Environment, RegExp][] = [
  ["sandbox", word("sandbox|sbx|playground|experiments?")],
  ["dev", word("non-?prod")],
  ["staging", word("stag|staging|stg|uat|pre-?prod")],
  ["prod", word("prod|production|prd|live")],
  ["dev", word("dev|develop|development|test|testing|qa")],
  ["shared", word("shared|security|audit|logs?|log-archive|network|networking|infra|infrastructure|management|platform|tooling|core")],
];

const classify = (value: string | undefined): Environment | undefined => {
  if (!value) return undefined;
  const v = value.toLowerCase();
  return ENV_PATTERNS.find(([, pattern]) => pattern.test(v))?.[0];
};

/**
 * Renderers colour accounts by environment. Real organizations encode it inconsistently, so try, in order: an
 * environment-like account tag, the account name, then the OU path (innermost first). Falls back to `shared`.
 */
export function inferEnvironment(tags: Record<string, string>, accountName: string, ouPath: readonly string[]): Environment {
  for (const key of ENV_TAG_KEYS) {
    const match = Object.entries(tags).find(([k]) => k.toLowerCase() === key);
    const env = classify(match?.[1]);
    if (env) return env;
  }
  return classify(accountName) ?? [...ouPath].reverse().map(classify).find(Boolean) ?? "shared";
}

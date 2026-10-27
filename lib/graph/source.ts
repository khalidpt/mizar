import { connection } from "next/server";
import { requireAccess } from "@/lib/auth/server";
import { serverConfig } from "@/lib/config";
import { openStore, type SnapshotStore } from "@/lib/store";
import { stripCosts } from "./cost";
import type { InfraGraph } from "./types";

let store: SnapshotStore | undefined;

/** Store described by the server's configuration, opened once per process. */
export function serverStore(): SnapshotStore {
  return (store ??= openStore(serverConfig()));
}

/**
 * The latest snapshot, read at request time so a new collection shows up on the next page load.
 * Null when nothing has been collected yet. Checks access first (sign-in or localhost-only), whatever the caller,
 * and drops cost figures when `ui.costs` is off, so they never reach the browser.
 */
export async function getGraph(): Promise<InfraGraph | null> {
  await connection();
  await requireAccess();
  const graph = await serverStore().latest();
  return graph && !serverConfig().ui.costs ? stripCosts(graph) : graph;
}

import { Suspense } from "react";
import { Booting } from "@/components/mizar/Booting";
import Mizar from "@/components/mizar/Mizar";
import { requireAccess } from "@/lib/auth/server";
import { getGraph } from "@/lib/graph/source";

export default function Home() {
  // The shell (loading screen) is prerendered; the snapshot streams in at request time.
  return (
    <Suspense fallback={<Booting />}>
      <LatestSnapshot />
    </Suspense>
  );
}

async function LatestSnapshot() {
  const [user, graph] = await Promise.all([requireAccess(), getGraph()]);
  return graph ? <Mizar graph={graph} user={user} /> : <NoSnapshot />;
}

function NoSnapshot() {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-[#02040b] p-6 font-mono text-slate-300">
      <section className="max-w-xl border border-teal-400/25 bg-slate-950/65 p-6">
        <h1 className="text-lg tracking-[0.4em] text-teal-200">MIZAR</h1>
        <p className="mt-4 text-sm text-slate-400">No infrastructure snapshot has been collected yet.</p>
        <p className="mt-4 text-xs uppercase tracking-widest text-teal-300/70">Collect one</p>
        <pre className="mt-2 overflow-x-auto border border-teal-400/15 bg-black/40 p-3 text-xs text-teal-100">npm run mizar -- collect</pre>
        <p className="mt-4 text-xs text-slate-500">
          This uses the configured collector (<code>mock</code> by default, no AWS access needed) and store. Then reload this page.
        </p>
      </section>
    </main>
  );
}

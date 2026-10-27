"use client";

import dynamic from "next/dynamic";
import type { User } from "@/lib/auth/session";
import type { InfraGraph } from "@/lib/graph/types";
import { SceneDataProvider } from "./data";
import { Hud } from "./Hud";
import { Booting } from "./Booting";
import { useMizar } from "./store";

// WebGL only exists in the browser; the 2D map is client-only too so the view can come from the URL.
const Scene = dynamic(() => import("./Scene"), { ssr: false, loading: () => <Booting /> });
const Map2D = dynamic(() => import("@/components/map2d/Map2D"), { ssr: false, loading: () => <Booting /> });

export default function Mizar({ graph, user }: { graph: InfraGraph; user: User | null }) {
  const view = useMizar((s) => s.view);
  return (
    <SceneDataProvider graph={graph}>
      <div className="relative h-dvh w-full overflow-hidden bg-[#02040b]">
        {view === "3d" ? <Scene /> : view === "2d" ? <Map2D /> : <Booting />}
        <Hud user={user} />
      </div>
    </SceneDataProvider>
  );
}

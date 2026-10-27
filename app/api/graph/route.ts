import { getGraph } from "@/lib/graph/source";

// Latest snapshot, read per request.
export async function GET() {
  const graph = await getGraph();
  if (!graph) return Response.json({ error: "No snapshot collected yet. Run: mizar collect" }, { status: 404 });
  return Response.json(graph);
}

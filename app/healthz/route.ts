// Liveness for load balancers and container health checks: open in every auth mode, reveals nothing.
export function GET() {
  return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

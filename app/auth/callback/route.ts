import { connection } from "next/server";
import { callback } from "@/lib/auth/oidc";
import { serverConfig } from "@/lib/config";

export async function GET(request: Request) {
  // Per request: without this the handler would be prerendered at build time.
  await connection();
  const auth = serverConfig().auth;
  return auth.mode === "oidc" ? callback(request, auth) : new Response("Sign-in is not configured", { status: 404 });
}

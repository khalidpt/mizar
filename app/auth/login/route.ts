import { connection } from "next/server";
import * as oidc from "@/lib/auth/oidc";
import * as saml from "@/lib/auth/saml";
import { serverConfig } from "@/lib/config";

export async function GET(request: Request) {
  // Per request: without this the handler would be prerendered at build time.
  await connection();
  const auth = serverConfig().auth;
  if (auth.mode === "oidc") return oidc.login(request, auth);
  if (auth.mode === "saml") return saml.login(request, auth);
  return new Response("Sign-in is not configured", { status: 404 });
}

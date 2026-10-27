import { acs } from "@/lib/auth/saml";
import { serverConfig } from "@/lib/config";

// The identity provider's response, posted by the browser (SAML HTTP-POST binding).
export async function POST(request: Request) {
  const auth = serverConfig().auth;
  return auth.mode === "saml" ? acs(request, auth) : new Response("SAML sign-in is not configured", { status: 404 });
}

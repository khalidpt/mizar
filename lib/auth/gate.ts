import { isLoopback } from "./oidc";
import { type AuthConfig, cookieName, readCookie, sessionUser } from "./session";

/**
 * The request check `proxy.ts` runs before every route: undefined lets the request through, a Response answers it.
 * Pages and the API also check again on their own (`requireAccess`), so a matcher gap can't expose the graph.
 */
export async function gate(request: Request, auth: AuthConfig): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return undefined;
  switch (auth.mode) {
    case "none":
      return undefined;
    case "localhost":
      // The server only listens on loopback; this also defeats DNS rebinding (a web page reaching it by another name).
      return isLoopbackHost(request.headers.get("host"))
        ? undefined
        : new Response("Mizar without sign-in only answers on localhost. Configure auth (see README).", { status: 403 });
    case "oidc":
    case "saml": {
      if (url.pathname.startsWith("/auth/")) return undefined;
      if (await sessionUser(auth, readCookie(request.headers.get("cookie"), cookieName(auth, "session")))) return undefined;
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Sign-in required" }, { status: 401 });
      const returnTo = `${url.pathname}${url.search}`;
      return Response.redirect(`${auth.publicUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, 307);
    }
  }
}

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  return isLoopback(hostname);
}

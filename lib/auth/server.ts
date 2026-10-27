import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { serverConfig } from "@/lib/config";
import { isLoopbackHost } from "./gate";
import { cookieName, sessionUser, type User } from "./session";

/**
 * Data access check, independent of `proxy.ts`: every read of infrastructure data goes through it. Returns the
 * signed-in user (OIDC or SAML) or null (no sign-in configured); otherwise redirects to sign-in or refuses.
 */
export async function requireAccess(): Promise<User | null> {
  const auth = serverConfig().auth;
  if (auth.mode === "none") return null;
  if (auth.mode === "localhost") {
    if (!isLoopbackHost((await headers()).get("host"))) throw new Error("Mizar without sign-in only answers on localhost");
    return null;
  }
  const user = await sessionUser(auth, (await cookies()).get(cookieName(auth, "session"))?.value);
  if (!user) redirect("/auth/login");
  return user;
}

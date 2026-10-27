import { hkdfSync } from "node:crypto";
import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";
import type { MizarConfig } from "@/lib/config";

export type AuthConfig = MizarConfig["auth"];

/** What the app knows about a signed-in user. Kept small: it lives in a cookie and is shown in the HUD. */
export interface User {
  sub: string;
  email?: string;
  name?: string;
}

/** Sessions are stateless: an encrypted, expiring JWT (JWE, A256GCM) in an HttpOnly cookie. Nothing is stored. */
type Purpose = "session" | "login";

function key(secret: string, purpose: Purpose): Uint8Array {
  // One key per purpose, so a login-transaction cookie can never be replayed as a session.
  return new Uint8Array(hkdfSync("sha256", secret, "mizar", `mizar ${purpose} cookie`, 32));
}

export async function seal(payload: JWTPayload, secret: string, purpose: Purpose, seconds: number): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${Math.floor(seconds)}s`)
    .encrypt(key(secret, purpose));
}

/** The payload, or null when the token is missing, tampered with, sealed for another purpose or expired. */
export async function unseal<T>(token: string | undefined, secret: string, purpose: Purpose): Promise<T | null> {
  if (!token) return null;
  try {
    return (await jwtDecrypt(token, key(secret, purpose))).payload as T;
  } catch {
    return null;
  }
}

/** `__Host-` cookies (Secure, Path=/, no Domain) whenever Mizar is served over HTTPS. */
export function cookieName(auth: AuthConfig, purpose: Purpose): string {
  return `${secure(auth) ? "__Host-" : ""}mizar-${purpose}`;
}

const secure = (auth: AuthConfig) => auth.publicUrl?.startsWith("https://") ?? false;

/**
 * `sameSite` is Lax by default: the session must survive the top-level redirect back from the identity provider.
 * SAML's login cookie needs None, as the provider posts its response back from another site; browsers only accept
 * that with Secure, so it falls back to Lax over plain HTTP (local development).
 */
export function setCookie(auth: AuthConfig, purpose: Purpose, value: string, maxAgeSeconds: number, sameSite: "Lax" | "None" = "Lax"): string {
  return [
    `${cookieName(auth, purpose)}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite === "None" && secure(auth) ? "None" : "Lax"}`,
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    ...(secure(auth) ? ["Secure"] : []),
  ].join("; ");
}

export function clearCookie(auth: AuthConfig, purpose: Purpose): string {
  return setCookie(auth, purpose, "", 0);
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The signed-in user from a session cookie value, if it is valid. */
export async function sessionUser(auth: AuthConfig, token: string | undefined): Promise<User | null> {
  const payload = await unseal<User>(token, auth.sessionSecret!, "session");
  return payload?.sub ? { sub: payload.sub, email: payload.email, name: payload.name } : null;
}

import * as oidc from "openid-client";
import { detail, page } from "./page";
import { authorize } from "./policy";
import { type AuthConfig, clearCookie, cookieName, readCookie, seal, setCookie, unseal } from "./session";

/**
 * OpenID Connect authorization code flow with PKCE, state and nonce, for any compliant provider (Okta, Entra ID,
 * Google, Keycloak, Cognito, ...). Route handlers in `app/auth/` call these with the incoming request.
 */

const LOGIN_SECONDS = 10 * 60;

const discovered = new Map<string, Promise<oidc.Configuration>>();

function configuration(auth: AuthConfig): Promise<oidc.Configuration> {
  const cacheKey = `${auth.issuer}\n${auth.clientId}`;
  let config = discovered.get(cacheKey);
  if (!config) {
    const issuer = new URL(auth.issuer!);
    // Plain HTTP only for a provider on this machine (development and tests).
    const local = issuer.protocol === "http:" && isLoopback(issuer.hostname);
    config = oidc
      .discovery(
        issuer,
        auth.clientId!,
        auth.clientSecret,
        auth.clientSecret ? undefined : oidc.None(),
        local ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error) => {
        discovered.delete(cacheKey);
        throw error;
      });
    discovered.set(cacheKey, config);
  }
  return config;
}

interface LoginTransaction {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/** `GET /auth/login[?returnTo=/path]`: starts sign-in at the provider. */
export async function login(request: Request, auth: AuthConfig): Promise<Response> {
  let config: oidc.Configuration;
  try {
    config = await configuration(auth);
  } catch (error) {
    console.error(`mizar: OIDC discovery for ${auth.issuer} failed: ${detail(error)}`);
    return page(502, "Sign-in unavailable", "The identity provider could not be reached. Try again shortly.");
  }
  const tx: LoginTransaction = {
    verifier: oidc.randomPKCECodeVerifier(),
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    returnTo: safeReturnTo(new URL(request.url).searchParams.get("returnTo")),
  };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${auth.publicUrl}/auth/callback`,
    scope: auth.scopes.join(" "),
    code_challenge: await oidc.calculatePKCECodeChallenge(tx.verifier),
    code_challenge_method: "S256",
    state: tx.state,
    nonce: tx.nonce,
  });
  const headers = new Headers({ Location: url.href, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", setCookie(auth, "login", await seal({ ...tx }, auth.sessionSecret!, "login", LOGIN_SECONDS), LOGIN_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** `GET /auth/callback`: the provider's redirect back. Verifies everything, then sets the session cookie. */
export async function callback(request: Request, auth: AuthConfig): Promise<Response> {
  const tx = await unseal<LoginTransaction>(readCookie(request.headers.get("cookie"), cookieName(auth, "login")), auth.sessionSecret!, "login");
  if (!tx) return page(400, "Sign-in expired", "This sign-in attempt is no longer valid.", true, auth);

  let claims: Record<string, unknown>;
  try {
    const config = await configuration(auth);
    // The URL the provider redirected to, as the browser saw it (Mizar may sit behind a proxy).
    const current = new URL(`${auth.publicUrl}/auth/callback${new URL(request.url).search}`);
    const tokens = await oidc.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims()! as Record<string, unknown>;
  } catch (error) {
    console.error(`mizar: sign-in failed: ${detail(error)}`);
    return page(400, "Sign-in failed", describe(error), true, auth);
  }

  const decision = authorize(claims, auth);
  if ("denied" in decision) return page(403, "Access denied", decision.denied, false, auth);

  const seconds = auth.sessionHours * 3600;
  const headers = new Headers({ Location: `${auth.publicUrl}${tx.returnTo}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", setCookie(auth, "session", await seal({ ...decision.user }, auth.sessionSecret!, "session", seconds), seconds));
  headers.append("Set-Cookie", clearCookie(auth, "login"));
  return new Response(null, { status: 302, headers });
}

/**
 * `POST /auth/logout`: ends the Mizar session. The provider's own session is left alone, so the next sign-in
 * may be immediate.
 */
export function logout(auth: AuthConfig): Response {
  const headers = new Headers({ Location: `${auth.publicUrl ?? ""}/auth/signed-out`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(auth, "session"));
  return new Response(null, { status: 303, headers });
}

export function signedOut(): Response {
  return page(200, "Signed out", "You have signed out of Mizar.", true);
}

/** Only same-origin paths: never `//host` or `/\host`, which browsers treat as another origin. */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function describe(error: unknown): string {
  // Provider-reported errors (access_denied, ...) are meant for users; anything else stays in the server log.
  if (error instanceof oidc.AuthorizationResponseError) return error.error_description ?? error.error;
  return "The identity provider's response could not be verified. Try again, or ask your administrator to check the server log.";
}

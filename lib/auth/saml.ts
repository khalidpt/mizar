import { randomBytes } from "node:crypto";
import { type CacheProvider, type Profile, SAML, SamlStatusError, ValidateInResponseTo } from "@node-saml/node-saml";
import { safeReturnTo } from "./oidc";
import { detail, page } from "./page";
import { authorize } from "./policy";
import { type AuthConfig, clearCookie, cookieName, readCookie, seal, setCookie, unseal } from "./session";

/**
 * SAML 2.0 sign-in for providers that don't offer OpenID Connect to custom applications, such as IAM Identity
 * Center: the request goes out by redirect, the signed response comes back as a form post to `/auth/saml/acs`.
 * Only sign-ins started here are accepted (no IdP-initiated sign-in). Route handlers in `app/auth/` call these.
 */

export const ACS_PATH = "/auth/saml/acs";

const LOGIN_SECONDS = 10 * 60;

interface LoginTransaction {
  requestId: string;
  /** ISO time the request was made; responses to it are accepted for `LOGIN_SECONDS`. */
  startedAt: string;
  returnTo: string;
}

/**
 * A client for one sign-in. The only request it accepts a response to is the one sealed in the browser's login
 * cookie, so nothing is stored on the server: unsolicited and replayed responses fail the InResponseTo check.
 */
function client(auth: AuthConfig, { requestId, startedAt }: Omit<LoginTransaction, "returnTo">): SAML {
  const pending: CacheProvider = {
    saveAsync: async (_key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (key === requestId ? startedAt : null),
    removeAsync: async (key) => key,
  };
  const { entryPoint, idpCert, entityId } = auth.saml;
  return new SAML({
    entryPoint,
    idpCert: idpCert!.includes("-----BEGIN") ? idpCert! : idpCert!.replace(/\s+/g, ""),
    issuer: entityId!,
    audience: entityId!,
    callbackUrl: `${auth.publicUrl}${ACS_PATH}`,
    generateUniqueId: () => requestId,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: LOGIN_SECONDS * 1000,
    cacheProvider: pending,
    // The assertion must be signed; a signature on the envelope as well is the provider's choice.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Let the provider choose the NameID format and how users authenticate (MFA included).
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60_000,
  });
}

/** `GET /auth/login[?returnTo=/path]`: starts sign-in at the provider. */
export async function login(request: Request, auth: AuthConfig): Promise<Response> {
  const tx: LoginTransaction = {
    // xsd:ID values may not start with a digit.
    requestId: `_${randomBytes(20).toString("hex")}`,
    startedAt: new Date().toISOString(),
    returnTo: safeReturnTo(new URL(request.url).searchParams.get("returnTo")),
  };
  let url: string;
  try {
    url = await client(auth, tx).getAuthorizeUrlAsync("", undefined, {});
  } catch (error) {
    console.error(`mizar: could not start SAML sign-in: ${detail(error)}`);
    return page(500, "Sign-in unavailable", "Sign-in is misconfigured. Ask your administrator to check the server log.");
  }
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  // SameSite=None: the provider's response is a form post from its own site.
  headers.append("Set-Cookie", setCookie(auth, "login", await seal({ ...tx }, auth.sessionSecret!, "login", LOGIN_SECONDS), LOGIN_SECONDS, "None"));
  return new Response(null, { status: 302, headers });
}

/** `POST /auth/saml/acs`: the provider's signed response. Verifies everything, then sets the session cookie. */
export async function acs(request: Request, auth: AuthConfig): Promise<Response> {
  const tx = await unseal<LoginTransaction>(readCookie(request.headers.get("cookie"), cookieName(auth, "login")), auth.sessionSecret!, "login");
  if (!tx) return page(400, "Sign-in expired", "This sign-in attempt is no longer valid.", true, auth);

  let claims: Record<string, unknown>;
  try {
    const form = await request.formData();
    const response = form.get("SAMLResponse");
    if (typeof response !== "string") throw new Error("the form has no SAMLResponse");
    const { profile } = await client(auth, tx).validatePostResponseAsync({ SAMLResponse: response });
    if (!profile?.nameID) throw new Error("the response signs no one in");
    // node-saml only checks idpIssuer on logout messages; this is the signed assertion's issuer.
    const { idpIssuer } = auth.saml;
    if (idpIssuer && profile.issuer !== idpIssuer) throw new Error(`assertion issued by ${profile.issuer}, expected ${idpIssuer}`);
    claims = claimsOf(profile, auth);
  } catch (error) {
    console.error(`mizar: SAML sign-in failed: ${detail(error)}`);
    return page(400, "Sign-in failed", describe(error), true, auth);
  }

  const decision = authorize(claims, auth);
  if ("denied" in decision) return page(403, "Access denied", decision.denied, false, auth);

  const seconds = auth.sessionHours * 3600;
  // 303: the browser follows with a GET.
  const headers = new Headers({ Location: `${auth.publicUrl}${tx.returnTo}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", setCookie(auth, "session", await seal({ ...decision.user }, auth.sessionSecret!, "session", seconds), seconds));
  headers.append("Set-Cookie", clearCookie(auth, "login"));
  return new Response(null, { status: 303, headers });
}

/**
 * Assertion attributes as the claims `authorize` reads. The NameID is the subject; email, name and groups come from
 * attributes with those names (as mapped in the provider) or their usual LDAP equivalents.
 */
function claimsOf(profile: Profile, auth: AuthConfig): Record<string, unknown> {
  const first = (...names: string[]) => {
    for (const name of names) {
      const value = profile[name];
      const text = Array.isArray(value) ? value.find((v) => typeof v === "string") : value;
      if (typeof text === "string" && text) return text;
    }
    return undefined;
  };
  const emailNameId = profile.nameIDFormat?.endsWith(":emailAddress") ? profile.nameID : undefined;
  return {
    sub: profile.nameID,
    email: first("email", "mail", "urn:oid:0.9.2342.19200300.100.1.3") ?? emailNameId,
    name: first("name", "displayName", "urn:oid:2.16.840.1.113730.3.1.241"),
    [auth.groupsClaim]: profile[auth.groupsClaim],
  };
}

function describe(error: unknown): string {
  // The provider's own refusal (no app assignment, failed authentication) is meant for users; details stay in the log.
  if (error instanceof SamlStatusError) return "The identity provider did not sign you in to this application. Ask your administrator for access.";
  return "The identity provider's response could not be verified. Try again, or ask your administrator to check the server log.";
}

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { loadConfig, redactConfig } from "@/lib/config";
import { type FakeIdp, startFakeIdp } from "./fake-idp";
import { type FakeSamlIdp, fakeSamlIdp } from "./fake-saml-idp";
import { gate, isLoopbackHost } from "./gate";
import { callback, login, logout, safeReturnTo } from "./oidc";
import { authorize } from "./policy";
import * as saml from "./saml";
import { type AuthConfig, cookieName, readCookie, seal, sessionUser } from "./session";

const SECRET = "x".repeat(32);
/** Settings from environment variables over the example file (never a developer's own mizar.config.json). */
const fromEnv = (vars: Record<string, string>) => loadConfig({ MIZAR_CONFIG: "mizar.config.example.json", ...vars });

describe("auth config", () => {
  test("defaults to localhost-only without an issuer, OIDC with one", () => {
    assert.equal(fromEnv({}).auth.mode, "localhost");
    const auth = fromEnv({
      MIZAR_AUTH_ISSUER: "https://idp.example.com",
      MIZAR_AUTH_CLIENT_ID: "mizar",
      MIZAR_AUTH_PUBLIC_URL: "https://mizar.example.com/",
      MIZAR_AUTH_SESSION_SECRET: SECRET,
      MIZAR_AUTH_ALLOWED_DOMAINS: "example.com, example.org",
    }).auth;
    assert.equal(auth.mode, "oidc");
    assert.equal(auth.publicUrl, "https://mizar.example.com");
    assert.deepEqual(auth.allowedDomains, ["example.com", "example.org"]);
  });

  test("OIDC needs a client, public URL and session secret", () => {
    assert.throws(() => fromEnv({ MIZAR_AUTH_ISSUER: "https://idp.example.com" }), /auth.clientId is required[\s\S]*auth.publicUrl[\s\S]*auth.sessionSecret/);
    assert.throws(() => fromEnv({ MIZAR_AUTH_MODE: "oidc" }), /auth.issuer is required/);
    assert.throws(
      () => fromEnv({ MIZAR_AUTH_ISSUER: "https://i", MIZAR_AUTH_CLIENT_ID: "c", MIZAR_AUTH_PUBLIC_URL: "https://o", MIZAR_AUTH_SESSION_SECRET: "short" }),
      /at least 32 characters/,
    );
  });

  test("SAML with an entry point; the entity id defaults to the public URL", () => {
    const auth = fromEnv({
      MIZAR_AUTH_SAML_ENTRY_POINT: "https://portal.sso.us-east-1.amazonaws.com/saml/assertion/abc",
      MIZAR_AUTH_SAML_IDP_CERT: "MIIC...",
      MIZAR_AUTH_PUBLIC_URL: "https://mizar.example.com/",
      MIZAR_AUTH_SESSION_SECRET: SECRET,
    }).auth;
    assert.equal(auth.mode, "saml");
    assert.equal(auth.saml.entityId, "https://mizar.example.com");
    assert.equal(fromEnv({ MIZAR_AUTH_MODE: "saml", MIZAR_AUTH_SAML_ENTRY_POINT: "https://i", MIZAR_AUTH_SAML_IDP_CERT: "c", MIZAR_AUTH_PUBLIC_URL: "https://o", MIZAR_AUTH_SESSION_SECRET: SECRET, MIZAR_AUTH_SAML_ENTITY_ID: "urn:mizar" }).auth.saml.entityId, "urn:mizar");
  });

  test("SAML needs an entry point, certificate, public URL and session secret", () => {
    assert.throws(() => fromEnv({ MIZAR_AUTH_MODE: "saml" }), /auth.publicUrl is required[\s\S]*auth.sessionSecret[\s\S]*auth.saml.entryPoint[\s\S]*auth.saml.idpCert/);
  });

  test("redacts sign-in secrets", () => {
    const config = fromEnv({
      MIZAR_AUTH_ISSUER: "https://idp.example.com",
      MIZAR_AUTH_CLIENT_ID: "mizar",
      MIZAR_AUTH_CLIENT_SECRET: "client-secret",
      MIZAR_AUTH_PUBLIC_URL: "https://mizar.example.com",
      MIZAR_AUTH_SESSION_SECRET: SECRET,
    });
    const printed = JSON.stringify(redactConfig(config));
    assert.ok(!printed.includes("client-secret") && !printed.includes(SECRET));
    assert.match(printed, /"clientSecret":"\*\*\*"/);
  });
});

const base: AuthConfig = {
  mode: "oidc",
  issuer: "https://idp.example.com",
  clientId: "mizar",
  publicUrl: "https://mizar.example.com",
  sessionSecret: SECRET,
  sessionHours: 12,
  scopes: ["openid", "email", "profile"],
  allowedEmails: [],
  allowedDomains: [],
  allowedGroups: [],
  groupsClaim: "groups",
  saml: { entityId: "https://mizar.example.com" },
};

describe("authorize", () => {
  const ada = { sub: "1", email: "Ada@Example.com", email_verified: true, name: "Ada", groups: ["eng"] };

  test("lets everyone in without allow lists", () => {
    assert.deepEqual(authorize(ada, base), { user: { sub: "1", email: "ada@example.com", name: "Ada" } });
  });

  test("matches emails, domains and groups", () => {
    assert.ok("user" in authorize(ada, { ...base, allowedEmails: ["ada@example.com"] }));
    assert.ok("user" in authorize(ada, { ...base, allowedDomains: ["@EXAMPLE.com"] }));
    assert.ok("user" in authorize(ada, { ...base, allowedGroups: ["eng"] }));
    assert.ok("user" in authorize({ ...ada, roles: "ops" }, { ...base, allowedGroups: ["ops"], groupsClaim: "roles" }));
    assert.ok("denied" in authorize(ada, { ...base, allowedDomains: ["example.org"], allowedGroups: ["ops"] }));
  });

  test("ignores unverified emails", () => {
    assert.ok("denied" in authorize({ ...ada, email_verified: false }, { ...base, allowedDomains: ["example.com"] }));
    assert.ok("denied" in authorize({ ...ada, email: "ada@example.com.evil.io" }, { ...base, allowedDomains: ["example.com"] }));
  });
});

describe("gate", () => {
  const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost:3000${path}`, { headers });

  test("localhost mode only answers loopback Host headers", async () => {
    const auth = { ...base, mode: "localhost" as const };
    assert.equal(await gate(req("/", { host: "localhost:3000" }), auth), undefined);
    assert.equal(await gate(req("/", { host: "127.0.0.1:3000" }), auth), undefined);
    assert.equal(await gate(req("/", { host: "[::1]:3000" }), auth), undefined);
    assert.equal((await gate(req("/", { host: "attacker.example:3000" }), auth))?.status, 403);
    assert.equal((await gate(req("/api/graph", {}), auth))?.status, 403);
    assert.ok(!isLoopbackHost("localhost.attacker.example"));
  });

  test("health checks pass in every mode", async () => {
    for (const mode of ["localhost", "oidc", "saml"] as const) {
      assert.equal(await gate(req("/healthz", { host: "10.0.1.23:3000" }), { ...base, mode }), undefined);
    }
  });

  test("none mode lets everything through", async () => {
    assert.equal(await gate(req("/", { host: "anything" }), { ...base, mode: "none" }), undefined);
  });

  test("OIDC mode: redirect pages, 401 for the API, pass with a session", async () => {
    const page = await gate(req("/?view=2d"), base);
    assert.equal(page?.status, 307);
    assert.equal(page?.headers.get("location"), "https://mizar.example.com/auth/login?returnTo=%2F%3Fview%3D2d");
    assert.equal((await gate(req("/api/graph"), base))?.status, 401);
    assert.equal(await gate(req("/auth/callback"), base), undefined);

    const token = await seal({ sub: "1" }, SECRET, "session", 60);
    assert.equal(await gate(req("/api/graph", { cookie: `${cookieName(base, "session")}=${token}` }), base), undefined);
    // A login-transaction token is not a session, and other secrets don't open sessions.
    const login = await seal({ sub: "1" }, SECRET, "login", 60);
    assert.equal((await gate(req("/api/graph", { cookie: `${cookieName(base, "session")}=${login}` }), base))?.status, 401);
    const foreign = await seal({ sub: "1" }, "y".repeat(32), "session", 60);
    assert.equal((await gate(req("/api/graph", { cookie: `${cookieName(base, "session")}=${foreign}` }), base))?.status, 401);
  });

  test("SAML mode guards like OIDC and lets the response through", async () => {
    const auth = { ...base, mode: "saml" as const };
    assert.equal((await gate(req("/"), auth))?.status, 307);
    assert.equal((await gate(req("/api/graph"), auth))?.status, 401);
    assert.equal(await gate(req("/auth/saml/acs"), auth), undefined);
  });
});

test("only same-origin return paths", () => {
  assert.equal(safeReturnTo("/?view=2d"), "/?view=2d");
  for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    assert.equal(safeReturnTo(bad), "/");
  }
});

describe("OIDC sign-in against a provider", () => {
  let idp: FakeIdp;
  let auth: AuthConfig;
  before(async () => {
    idp = await startFakeIdp({ clientId: "mizar", clientSecret: "s3cret" });
    auth = { ...base, issuer: idp.issuer, clientSecret: "s3cret", publicUrl: "http://localhost:3000" };
  });
  after(() => idp.close());

  /** Browser-like run: /auth/login → provider → /auth/callback, carrying the login cookie. */
  async function signIn(returnTo = "/?view=2d", options: { dropCookie?: boolean; state?: string } = {}) {
    const start = await login(new Request(`http://internal:3000/auth/login?returnTo=${encodeURIComponent(returnTo)}`), auth);
    assert.equal(start.status, 302);
    const loginCookie = start.headers.getSetCookie()[0].split(";")[0];
    assert.match(loginCookie, /^mizar-login=/);
    const authorizeUrl = new URL(start.headers.get("location")!);
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://localhost:3000/auth/callback");

    const back = await fetch(authorizeUrl, { redirect: "manual" });
    const callbackUrl = new URL(back.headers.get("location")!);
    if (options.state) callbackUrl.searchParams.set("state", options.state);
    // Behind a proxy the server sees an internal URL; the callback rebuilds it from publicUrl.
    return callback(
      new Request(`http://internal:3000${callbackUrl.pathname}${callbackUrl.search}`, { headers: options.dropCookie ? {} : { cookie: loginCookie } }),
      auth,
    );
  }

  const sessionOf = (response: Response) =>
    sessionUser(auth, readCookie(response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), cookieName(auth, "session")));

  test("signs in and returns to the requested page", async () => {
    idp.user = { sub: "user-1", email: "ada@example.com", email_verified: true, name: "Ada" };
    const done = await signIn();
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "http://localhost:3000/?view=2d");
    const cookies = done.headers.getSetCookie();
    assert.match(cookies[0], /^mizar-session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    assert.match(cookies[1], /^mizar-login=; .*Max-Age=0/);
    assert.deepEqual(await sessionOf(done), { sub: "user-1", email: "ada@example.com", name: "Ada" });
  });

  test("works as a public client (PKCE, no secret)", async () => {
    const pub = await startFakeIdp({ clientId: "public" });
    try {
      const saved = auth;
      auth = { ...base, issuer: pub.issuer, clientId: "public", publicUrl: "http://localhost:3000" };
      const done = await signIn("/");
      assert.equal(done.status, 302);
      auth = saved;
    } finally {
      await pub.close();
    }
  });

  test("refuses users outside the allow lists", async () => {
    idp.user = { sub: "user-2", email: "eve@elsewhere.example", email_verified: true };
    auth = { ...auth, allowedDomains: ["example.com"] };
    const denied = await signIn();
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /eve@elsewhere.example is not allowed/);
    assert.equal(await sessionOf(denied), null);
    auth = { ...auth, allowedDomains: [] };
  });

  test("rejects a tampered state, a missing login cookie, a wrong nonce and provider errors", async () => {
    idp.user = { sub: "user-1" };
    assert.equal((await signIn("/", { state: "forged" })).status, 400);
    assert.match(await (await signIn("/", { dropCookie: true })).text(), /Sign-in expired/);

    idp.tamper = { nonce: "replayed" };
    const badNonce = await signIn();
    assert.equal(badNonce.status, 400);
    assert.match(await badNonce.text(), /could not be verified/);
    idp.tamper = { aud: "someone-else" };
    assert.equal((await signIn()).status, 400);
    idp.tamper = {};

    idp.user = { error: "access_denied" };
    const refused = await signIn();
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /access_denied/);
  });

  test("ignores off-site return paths", async () => {
    idp.user = { sub: "user-1" };
    assert.equal((await signIn("//evil.example/x")).headers.get("location"), "http://localhost:3000/");
  });

  test("logout clears the session", () => {
    const out = logout(auth);
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "http://localhost:3000/auth/signed-out");
    assert.match(out.headers.getSetCookie()[0], /^mizar-session=; .*Max-Age=0/);
  });

  test("uses __Host- cookies over HTTPS", () => {
    assert.equal(cookieName(base, "session"), "__Host-mizar-session");
    assert.match(logout(base).headers.getSetCookie()[0], /^__Host-mizar-session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  });
});

describe("SAML sign-in against a provider", () => {
  let idp: FakeSamlIdp;
  let auth: AuthConfig;
  before(() => {
    idp = fakeSamlIdp();
    auth = { ...base, mode: "saml", issuer: undefined, clientId: undefined, saml: { entryPoint: idp.entryPoint, idpCert: idp.cert, idpIssuer: idp.issuer, entityId: base.publicUrl } };
  });

  /** Browser-like run: /auth/login → provider → form post to /auth/saml/acs, carrying the login cookie. */
  async function signIn(returnTo = "/?view=2d", options: { dropCookie?: boolean; otherLogin?: boolean } = {}) {
    const start = async () => {
      const response = await saml.login(new Request(`http://internal:3000/auth/login?returnTo=${encodeURIComponent(returnTo)}`), auth);
      assert.equal(response.status, 302);
      return { location: response.headers.get("location")!, cookie: response.headers.getSetCookie()[0] };
    };
    const first = await start();
    assert.ok(first.location.startsWith(`${idp.entryPoint}?SAMLRequest=`));
    // The provider posts back from its own site, so the login cookie must be SameSite=None.
    assert.match(first.cookie, /^__Host-mizar-login=.+; Path=\/; HttpOnly; SameSite=None; Max-Age=600; Secure$/);
    const posted = idp.respond(first.location);
    const cookie = options.otherLogin ? (await start()).cookie : first.cookie;
    return saml.acs(
      new Request(`http://internal:3000${saml.ACS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(options.dropCookie ? {} : { cookie: cookie.split(";")[0] }) },
        body: new URLSearchParams({ SAMLResponse: posted }),
      }),
      auth,
    );
  }

  const sessionOf = (response: Response) =>
    sessionUser(auth, readCookie(response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), cookieName(auth, "session")));

  test("signs in and returns to the requested page", async () => {
    idp.user = { nameID: "user-1", attributes: { email: "Ada@Example.com", name: "Ada" } };
    const done = await signIn();
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "https://mizar.example.com/?view=2d");
    const cookies = done.headers.getSetCookie();
    assert.match(cookies[0], /^__Host-mizar-session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    assert.match(cookies[1], /^__Host-mizar-login=; .*Max-Age=0/);
    assert.deepEqual(await sessionOf(done), { sub: "user-1", email: "ada@example.com", name: "Ada" });
  });

  test("takes the email from an email-format NameID and applies the allow lists", async () => {
    idp.user = { nameID: "eve@elsewhere.example", nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", attributes: { groups: ["ops", "eng"] } };
    auth = { ...auth, allowedDomains: ["example.com"] };
    const denied = await signIn();
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /eve@elsewhere.example is not allowed/);
    auth = { ...auth, allowedGroups: ["eng"] };
    assert.deepEqual(await sessionOf(await signIn()), { sub: "eve@elsewhere.example", email: "eve@elsewhere.example", name: "eve@elsewhere.example" });
    auth = { ...auth, allowedDomains: [], allowedGroups: [] };
  });

  test("rejects responses that are forged, misaddressed, unsolicited or for another sign-in", async () => {
    idp.user = { nameID: "user-1" };
    const tampers: FakeSamlIdp["tamper"][] = [
      { unsigned: true },
      { foreignKey: true },
      { editAfterSigning: true },
      { audience: "https://other-app.example.com" },
      { issuer: "https://evil.example.com" },
      { inResponseTo: null },
      { inResponseTo: "_someone-elses-request" },
    ];
    for (const tamper of tampers) {
      idp.tamper = tamper;
      const rejected = await signIn();
      assert.equal(rejected.status, 400, JSON.stringify(tamper));
      assert.match(await rejected.text(), /could not be verified/);
      assert.equal(await sessionOf(rejected), null);
    }
    idp.tamper = {};
    assert.equal((await signIn("/", { otherLogin: true })).status, 400);
    assert.match(await (await signIn("/", { dropCookie: true })).text(), /Sign-in expired/);
  });

  test("explains a refusal by the provider", async () => {
    idp.user = { nameID: "user-1", status: "urn:oasis:names:tc:SAML:2.0:status:Responder" };
    const refused = await signIn();
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /did not sign you in to this application/);
  });

  test("ignores off-site return paths", async () => {
    idp.user = { nameID: "user-1" };
    assert.equal((await signIn("//evil.example/x")).headers.get("location"), "https://mizar.example.com/");
  });
});

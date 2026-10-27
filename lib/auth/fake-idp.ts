import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * A minimal OpenID Connect provider for tests and local development only: discovery, JWKS, an authorize endpoint
 * that signs in `user` without a login form, and a token endpoint that checks the client secret and PKCE and issues
 * RS256 ID tokens. Never use it for anything real.
 */
export interface FakeIdp {
  issuer: string;
  /** Claims of whoever "signs in" next. */
  user: Record<string, unknown>;
  /** Overrides for the next ID token (e.g. a wrong nonce or audience). */
  tamper: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startFakeIdp(options: {
  clientId: string;
  clientSecret?: string;
  port?: number;
  /** Interface to listen on (e.g. 0.0.0.0 in a container); the issuer URL always says 127.0.0.1. */
  listen?: string;
}): Promise<FakeIdp> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce?: string; challenge?: string; redirectUri: string; claims: Record<string, unknown> }>();

  const idp: FakeIdp = { issuer: "", user: { sub: "user-1", email: "ada@example.com", email_verified: true, name: "Ada" }, tamper: {}, close: async () => {} };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, idp.issuer);
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });

    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== options.clientId || p.get("response_type") !== "code") return json(400, { error: "invalid_request" });
      const redirect = new URL(p.get("redirect_uri")!);
      if (idp.user.error) {
        redirect.searchParams.set("error", String(idp.user.error));
      } else {
        const code = randomBytes(16).toString("hex");
        codes.set(code, { nonce: p.get("nonce") ?? undefined, challenge: p.get("code_challenge") ?? undefined, redirectUri: redirect.href, claims: { ...idp.user } });
        redirect.searchParams.set("code", code);
      }
      if (p.get("state")) redirect.searchParams.set("state", p.get("state")!);
      return res.writeHead(302, { Location: redirect.href }).end();
    }

    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : [form.get("client_id"), form.get("client_secret")];
      if (basic[0] !== options.clientId || (options.clientSecret && basic[1] !== options.clientSecret)) return json(401, { error: "invalid_client" });

      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!grant || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== challenge) return json(400, { error: "invalid_grant" });

      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: idp.issuer, aud: options.clientId, iat: now, exp: now + 300, ...grant.claims, nonce: grant.nonce, ...idp.tamper };
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
      return json(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.listen ?? "127.0.0.1", resolve));
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.close = () => new Promise((resolve) => server.close(() => resolve()));
  return idp;
}

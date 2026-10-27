import { generateKeyPairSync, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

/**
 * A minimal SAML 2.0 identity provider for tests only: reads the AuthnRequest from a sign-in redirect and answers it
 * with a response whose assertion is signed (RSA-SHA256) for `user`. Never use it for anything real.
 */
export interface FakeSamlIdp {
  entryPoint: string;
  issuer: string;
  /** Public key PEM, used as `auth.saml.idpCert`. */
  cert: string;
  /** NameID and attributes of whoever "signs in" next; `status` answers with that SAML status instead. */
  user: { nameID: string; nameIDFormat?: string; attributes?: Record<string, string | string[]>; status?: string };
  /** Overrides for the next response, to test what must be rejected. */
  tamper: { audience?: string; inResponseTo?: string | null; issuer?: string; foreignKey?: boolean; unsigned?: boolean; editAfterSigning?: boolean };
  /** The base64 SAMLResponse a browser would post, for the request in `authorizeUrl` (the redirect to `entryPoint`). */
  respond(authorizeUrl: string): string;
}

const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';

export function fakeSamlIdp(): FakeSamlIdp {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = (key: typeof keys.privateKey) => key.export({ type: "pkcs8", format: "pem" }).toString();

  const idp: FakeSamlIdp = {
    entryPoint: "https://idp.example.com/saml/sso",
    issuer: "https://idp.example.com/saml/issuer",
    cert: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    user: { nameID: "user-1", attributes: { email: "ada@example.com", name: "Ada" } },
    tamper: {},
    respond(authorizeUrl) {
      const request = inflateRawSync(Buffer.from(new URL(authorizeUrl).searchParams.get("SAMLRequest")!, "base64")).toString();
      const attr = (name: string) => request.match(new RegExp(`${name}="([^"]*)"`))?.[1];
      const acs = attr("AssertionConsumerServiceURL")!;
      const t = idp.tamper;
      const inResponseTo = t.inResponseTo === null ? "" : ` InResponseTo="${esc(t.inResponseTo ?? attr("ID")!)}"`;
      const issuer = `<saml:Issuer>${esc(t.issuer ?? idp.issuer)}</saml:Issuer>`;
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000).toISOString();
      const id = () => `_${randomBytes(16).toString("hex")}`;

      const head = `<samlp:Response ${NS} ID="${id()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${esc(acs)}"${inResponseTo}>${issuer}`;
      if (idp.user.status) {
        const status = `<samlp:Status><samlp:StatusCode Value="${esc(idp.user.status)}"/></samlp:Status>`;
        return Buffer.from(`${head}${status}</samlp:Response>`).toString("base64");
      }

      const attributes = Object.entries(idp.user.attributes ?? {})
        .map(([name, value]) => {
          const values = (Array.isArray(value) ? value : [value]).map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join("");
          return `<saml:Attribute Name="${esc(name)}">${values}</saml:Attribute>`;
        })
        .join("");
      const format = idp.user.nameIDFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
      let assertion =
        `<saml:Assertion ${NS} ID="${id()}" Version="2.0" IssueInstant="${now.toISOString()}">${issuer}` +
        `<saml:Subject><saml:NameID Format="${esc(format)}">${esc(idp.user.nameID)}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${later}" Recipient="${esc(acs)}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${esc(t.audience ?? issuerOf(request))}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : "") +
        `</saml:Assertion>`;

      if (!t.unsigned) {
        const signer = new SignedXml({
          privateKey: pem(t.foreignKey ? foreign.privateKey : keys.privateKey),
          signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
          canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
        });
        signer.addReference({
          xpath: "/*[local-name(.)='Assertion']",
          digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
          transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
        });
        signer.computeSignature(assertion, { location: { reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
        assertion = signer.getSignedXml();
      }
      if (t.editAfterSigning) assertion = assertion.replace(`>${esc(idp.user.nameID)}<`, ">someone-else<");

      const success = '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>';
      return Buffer.from(`${head}${success}${assertion}</samlp:Response>`).toString("base64");
    },
  };
  return idp;
}

/** The AuthnRequest's `<saml:Issuer>`: the service provider's entity id, which the assertion is addressed to. */
function issuerOf(request: string): string {
  return request.match(/<saml:Issuer[^>]*>([^<]*)<\/saml:Issuer>/)![1];
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

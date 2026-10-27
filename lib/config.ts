import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Mizar configuration. Precedence: defaults < `mizar.config.json` (or the file named by `MIZAR_CONFIG`, or the
 * same JSON inline in `MIZAR_CONFIG_JSON`) < `MIZAR_*` environment variables. Every deployment-specific knob
 * belongs here.
 */
const ConfigSchema = z.object({
  /** Snapshot store URL: `file://<dir>` or `s3://<bucket>[/<prefix>]`; `sqlite://`, `postgres://` planned. */
  store: z.string().min(1).default("file://./data/snapshots"),
  /** How many snapshots the store keeps; older ones are pruned after each save. */
  retain: z.number().int().positive().default(48),
  /** Which collector produces snapshots. */
  source: z.enum(["mock", "aws"]).default("mock"),
  mock: z
    .object({
      seed: z.number().int().default(42),
      teams: z.number().int().min(1).default(4),
      sandboxes: z.number().int().min(0).default(2),
    })
    .prefault({}),
  aws: z
    .object({
      /**
       * Which accounts to collect. `organization`: every active account in the AWS Organization (run from the
       * management account or a delegated admin). `accounts`: only `accounts`. `current`: only the caller's account.
       */
      scope: z.enum(["organization", "accounts", "current"]).default("organization"),
      accounts: z.array(z.string().regex(/^\d{12}$/, "AWS account ids are 12 digits")).default([]),
      excludeAccounts: z.array(z.string().regex(/^\d{12}$/, "AWS account ids are 12 digits")).default([]),
      /** Regions to scan; empty means every region enabled in each account. */
      regions: z.array(z.string().min(1)).default([]),
      /** Region for global APIs (STS, Organizations, region discovery). Defaults to the SDK's (env or profile), then us-east-1. */
      region: z.string().min(1).optional(),
      /** Read-only role assumed in each collected account. */
      roleName: z.string().min(1).default("MizarReadOnly"),
      rolePath: z.string().startsWith("/").endsWith("/").default("/"),
      externalId: z.string().min(1).optional(),
      /** Also assume `roleName` in the caller's own account instead of using the caller's credentials directly. */
      assumeRoleInCallerAccount: z.boolean().default(false),
      /** Display name of the organization root node (defaults to the organization id). */
      name: z.string().min(1).optional(),
      /**
       * Where the resource inventory comes from. `direct`: service APIs in every account and region (needs the
       * read-only role everywhere). `config`: one AWS Config aggregator query in the collecting account.
       */
      inventory: z.enum(["direct", "config"]).default("direct"),
      /** Aggregator name for `inventory: "config"`. */
      configAggregator: z.string().min(1).optional(),
      /** Region the aggregator lives in; defaults to `region`. */
      configAggregatorRegion: z.string().min(1).optional(),
      /**
       * With `inventory: "config"`, also assume the read-only role where needed to add what Config doesn't record
       * (load balancer targets and health, ECS task counts, Lambda event sources, alarm states). Off: no member roles.
       */
      enrich: z.boolean().default(true),
      /**
       * Spend per account, region and top services from Cost Explorer (a cent per query, a few per collection).
       * Read from one account: the management account sees every account, any other only itself.
       */
      cost: z
        .object({
          enabled: z.boolean().default(false),
          /** Account to read costs from; defaults to the Organization's management account, else the caller's. */
          accountId: z.string().regex(/^\d{12}$/, "AWS account ids are 12 digits").optional(),
          /** Role assumed there (unless it is the caller's own account); uses `aws.externalId` too. */
          roleName: z.string().min(1).default("MizarCostReader"),
          rolePath: z.string().startsWith("/").endsWith("/").default("/"),
          /** Unblended (default), net of discounts, amortized (reservations and savings plans spread out), ... */
          metric: z.enum(["UnblendedCost", "NetUnblendedCost", "AmortizedCost", "NetAmortizedCost", "BlendedCost"]).default("UnblendedCost"),
        })
        .prefault({}),
      /** Every region has a default VPC; unused ones are hidden unless this is on. */
      includeEmptyDefaultVpcs: z.boolean().default(false),
      concurrency: z
        .object({
          accounts: z.number().int().positive().default(4),
          regions: z.number().int().positive().default(4),
        })
        .prefault({}),
    })
    .prefault({}),
  ui: z
    .object({
      /**
       * Show spend (from `aws.cost`) in the web app. Off: the server removes every cost figure before sending a
       * snapshot to the browser or `/api/graph`, for teams that collect costs but don't share them with every viewer.
       */
      costs: z.boolean().default(true),
    })
    .prefault({}),
  auth: z
    .object({
      /**
       * `oidc`: sign in with any OpenID Connect provider. `saml`: sign in with a SAML 2.0 identity provider (IAM
       * Identity Center). `localhost` (the default without either): no sign-in, but the server only listens on
       * loopback and rejects other Host headers. `none`: no sign-in at all, for when something in front already
       * authenticates (ALB + OIDC, SSM port forwarding).
       */
      mode: z.enum(["oidc", "saml", "localhost", "none"]).optional(),
      /** Issuer URL; its `/.well-known/openid-configuration` is discovered. */
      issuer: z.url().optional(),
      clientId: z.string().min(1).optional(),
      /** Omit for a public client (PKCE only). */
      clientSecret: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).default(["openid", "email", "profile"]),
      /** URL users open, e.g. `https://mizar.example.com`; the redirect URI is `<publicUrl>/auth/callback`. */
      publicUrl: z.url().optional(),
      /** Encrypts session cookies; at least 32 characters, the same on every replica. */
      sessionSecret: z.string().min(32, "auth.sessionSecret needs at least 32 characters").optional(),
      sessionHours: z.number().positive().max(24 * 30).default(12),
      /** Who may sign in. All empty: anyone the provider authenticates (restrict it there, e.g. app assignment). */
      allowedEmails: z.array(z.string().min(1)).default([]),
      allowedDomains: z.array(z.string().min(1)).default([]),
      allowedGroups: z.array(z.string().min(1)).default([]),
      /** ID token claim (or SAML attribute) holding the user's groups. */
      groupsClaim: z.string().min(1).default("groups"),
      /** SAML 2.0 sign-in; the response comes back to `<publicUrl>/auth/saml/acs`. */
      saml: z
        .object({
          /** The provider's sign-in URL (IAM Identity Center: "IAM Identity Center sign-in URL"). */
          entryPoint: z.url().optional(),
          /** The provider's signing certificate: PEM, or the base64 between its BEGIN and END lines. */
          idpCert: z.string().min(1).optional(),
          /** Issuer the provider's responses must name (IAM Identity Center: "IAM Identity Center issuer URL"). */
          idpIssuer: z.string().min(1).optional(),
          /** This app's entity id, which responses must be addressed to; defaults to `publicUrl`. */
          entityId: z.string().min(1).optional(),
        })
        .prefault({}),
    })
    .prefault({})
    .transform((auth, ctx) => {
      const mode = auth.mode ?? (auth.issuer ? "oidc" : auth.saml.entryPoint ? "saml" : "localhost");
      if (mode === "oidc") {
        for (const key of ["issuer", "clientId", "publicUrl", "sessionSecret"] as const) {
          if (!auth[key]) ctx.addIssue({ code: "custom", path: [key], message: `auth.${key} is required for OIDC sign-in` });
        }
      }
      if (mode === "saml") {
        for (const key of ["publicUrl", "sessionSecret"] as const) {
          if (!auth[key]) ctx.addIssue({ code: "custom", path: [key], message: `auth.${key} is required for SAML sign-in` });
        }
        for (const key of ["entryPoint", "idpCert"] as const) {
          if (!auth.saml[key]) ctx.addIssue({ code: "custom", path: ["saml", key], message: `auth.saml.${key} is required for SAML sign-in` });
        }
      }
      const publicUrl = auth.publicUrl?.replace(/\/+$/, "");
      return { ...auth, mode, publicUrl, saml: { ...auth.saml, entityId: auth.saml.entityId ?? publicUrl } };
    }),
});

export type MizarConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_FILE = "mizar.config.json";

export function loadConfig(env: Record<string, string | undefined> = process.env): MizarConfig {
  const explicitFile = env.MIZAR_CONFIG;
  const file = explicitFile ?? DEFAULT_CONFIG_FILE;
  let fromFile: unknown = {};
  if (env.MIZAR_CONFIG_JSON) {
    // Inline file contents, for containers and templates where mounting a file is awkward.
    if (explicitFile) throw new Error("Set MIZAR_CONFIG or MIZAR_CONFIG_JSON, not both");
    try {
      fromFile = JSON.parse(env.MIZAR_CONFIG_JSON);
    } catch (error) {
      throw new Error(`Could not parse MIZAR_CONFIG_JSON: ${(error as Error).message}`);
    }
  } else if (existsSync(/*turbopackIgnore: true*/ file)) {
    // Runtime user file, not code: keep it out of Next's output file tracing.
    try {
      fromFile = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse ${file}: ${(error as Error).message}`);
    }
  } else if (explicitFile) {
    throw new Error(`MIZAR_CONFIG points to ${explicitFile}, which does not exist`);
  }

  const fromEnv = Object.fromEntries(
    Object.entries({
      store: env.MIZAR_STORE,
      retain: env.MIZAR_RETAIN === undefined ? undefined : Number(env.MIZAR_RETAIN),
      source: env.MIZAR_SOURCE,
    }).filter(([, v]) => v !== undefined && v !== ""),
  );

  const list = (value: string | undefined) =>
    value === undefined || value === "" ? undefined : value.split(",").map((v) => v.trim()).filter(Boolean);
  const awsFromEnv = Object.fromEntries(
    Object.entries({
      scope: env.MIZAR_AWS_SCOPE,
      accounts: list(env.MIZAR_AWS_ACCOUNTS),
      excludeAccounts: list(env.MIZAR_AWS_EXCLUDE_ACCOUNTS),
      regions: list(env.MIZAR_AWS_REGIONS),
      region: env.MIZAR_AWS_REGION,
      roleName: env.MIZAR_AWS_ROLE_NAME,
      externalId: env.MIZAR_AWS_EXTERNAL_ID,
      inventory: env.MIZAR_AWS_INVENTORY,
      configAggregator: env.MIZAR_AWS_CONFIG_AGGREGATOR,
      configAggregatorRegion: env.MIZAR_AWS_CONFIG_AGGREGATOR_REGION,
      enrich: env.MIZAR_AWS_ENRICH === undefined || env.MIZAR_AWS_ENRICH === "" ? undefined : env.MIZAR_AWS_ENRICH !== "false",
    }).filter(([, v]) => v !== undefined && v !== ""),
  );

  const costFromEnv = Object.fromEntries(
    Object.entries({
      enabled: env.MIZAR_AWS_COST === undefined || env.MIZAR_AWS_COST === "" ? undefined : env.MIZAR_AWS_COST !== "false",
      accountId: env.MIZAR_AWS_COST_ACCOUNT_ID,
      roleName: env.MIZAR_AWS_COST_ROLE_NAME,
      metric: env.MIZAR_AWS_COST_METRIC,
    }).filter(([, v]) => v !== undefined && v !== ""),
  );

  const uiFromEnv = Object.fromEntries(
    Object.entries({
      costs: env.MIZAR_UI_COSTS === undefined || env.MIZAR_UI_COSTS === "" ? undefined : env.MIZAR_UI_COSTS !== "false",
    }).filter(([, v]) => v !== undefined),
  );

  const authFromEnv = Object.fromEntries(
    Object.entries({
      mode: env.MIZAR_AUTH_MODE,
      issuer: env.MIZAR_AUTH_ISSUER,
      clientId: env.MIZAR_AUTH_CLIENT_ID,
      clientSecret: env.MIZAR_AUTH_CLIENT_SECRET,
      publicUrl: env.MIZAR_AUTH_PUBLIC_URL,
      sessionSecret: env.MIZAR_AUTH_SESSION_SECRET,
      sessionHours: env.MIZAR_AUTH_SESSION_HOURS === undefined || env.MIZAR_AUTH_SESSION_HOURS === "" ? undefined : Number(env.MIZAR_AUTH_SESSION_HOURS),
      allowedEmails: list(env.MIZAR_AUTH_ALLOWED_EMAILS),
      allowedDomains: list(env.MIZAR_AUTH_ALLOWED_DOMAINS),
      allowedGroups: list(env.MIZAR_AUTH_ALLOWED_GROUPS),
    }).filter(([, v]) => v !== undefined && v !== ""),
  );

  const samlFromEnv = Object.fromEntries(
    Object.entries({
      entryPoint: env.MIZAR_AUTH_SAML_ENTRY_POINT,
      idpCert: env.MIZAR_AUTH_SAML_IDP_CERT,
      idpIssuer: env.MIZAR_AUTH_SAML_IDP_ISSUER,
      entityId: env.MIZAR_AUTH_SAML_ENTITY_ID,
    }).filter(([, v]) => v !== undefined && v !== ""),
  );

  const fileConfig = fromFile as { aws?: { cost?: object }; ui?: object; auth?: { saml?: object } };
  const result = ConfigSchema.safeParse({
    ...fileConfig,
    ...fromEnv,
    aws: { ...fileConfig.aws, ...awsFromEnv, cost: { ...fileConfig.aws?.cost, ...costFromEnv } },
    ui: { ...fileConfig.ui, ...uiFromEnv },
    auth: { ...fileConfig.auth, ...authFromEnv, saml: { ...fileConfig.auth?.saml, ...samlFromEnv } },
  });
  if (!result.success) {
    throw new Error(`Invalid Mizar configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let serverConfigCache: MizarConfig | undefined;

/** The web server's configuration, loaded once per process. */
export function serverConfig(): MizarConfig {
  return (serverConfigCache ??= loadConfig());
}

/** Configuration safe to print: store credentials, the role external id and sign-in secrets are masked. */
export function redactConfig(config: MizarConfig): MizarConfig {
  const mask = <T extends object>(value: T, keys: (keyof T)[]) =>
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v !== undefined && keys.includes(k as keyof T) ? "***" : v])) as T;
  return {
    ...config,
    store: redactUrl(config.store),
    aws: mask(config.aws, ["externalId"]),
    auth: mask(config.auth, ["clientSecret", "sessionSecret"]),
  };
}

/** Store URL safe to print: credentials in `scheme://user:password@host` are masked. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z0-9+.-]+:\/\/)([^/@]*)@/i, (_, scheme: string, userinfo: string) => {
    const user = userinfo.split(":")[0];
    return `${scheme}${user ? `${user}:` : ""}***@`;
  });
}

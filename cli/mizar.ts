import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectOnce } from "@/lib/collect";
import { loadConfig, redactConfig, redactUrl, type MizarConfig } from "@/lib/config";
import { checkSnapshot } from "@/lib/graph/schema";
import { openStore } from "@/lib/store";

const HELP = `mizar — collect and inspect infrastructure snapshots

Usage:
  mizar collect [--source mock|aws] [--every <minutes>]   Take a snapshot (once, or repeatedly)
          [--scope organization|accounts|current] [--accounts <id,...>] [--regions <region,...>]
          [--inventory direct|config]
  mizar snapshots [--limit <n>]                           List stored snapshots, newest first
  mizar validate <file.json>...                           Check snapshots against the InfraGraph v1 contract
  mizar config                                            Print the effective configuration
  mizar serve                                             Start the web app (Docker image only)

Configuration: defaults < mizar.config.json (or $MIZAR_CONFIG) < MIZAR_* env vars < flags.
  MIZAR_STORE                snapshot store URL: file://<dir> (default file://./data/snapshots)
                               or s3://<bucket>[/<prefix>][?region=<region>]
  MIZAR_SOURCE               collector: mock (default) or aws
  MIZAR_RETAIN               snapshots to keep (default 48)
  MIZAR_AWS_SCOPE            organization (default), accounts or current
  MIZAR_AWS_ACCOUNTS         account ids for scope "accounts" (comma-separated)
  MIZAR_AWS_EXCLUDE_ACCOUNTS account ids never collected
  MIZAR_AWS_REGIONS          regions to scan (default: every enabled region)
  MIZAR_AWS_REGION           region for global APIs and the aggregator (default: SDK region, then us-east-1)
  MIZAR_AWS_ROLE_NAME        role assumed in each account (default MizarReadOnly)
  MIZAR_AWS_EXTERNAL_ID      external id for that role, if required
  MIZAR_AWS_INVENTORY        direct (default: service APIs in every account) or config (AWS Config aggregator)
  MIZAR_AWS_CONFIG_AGGREGATOR         aggregator name, for inventory "config"
  MIZAR_AWS_CONFIG_AGGREGATOR_REGION  its region (default: MIZAR_AWS_REGION)
  MIZAR_AWS_ENRICH           false: with inventory "config", never assume member roles
  MIZAR_AUTH_MODE            oidc (default with an issuer), saml (default with a SAML entry point),
                             localhost (default otherwise) or none
  MIZAR_AUTH_ISSUER, MIZAR_AUTH_CLIENT_ID, MIZAR_AUTH_CLIENT_SECRET, MIZAR_AUTH_PUBLIC_URL,
  MIZAR_AUTH_SESSION_SECRET  OpenID Connect sign-in (see README)
  MIZAR_AUTH_SAML_ENTRY_POINT, MIZAR_AUTH_SAML_IDP_CERT, MIZAR_AUTH_SAML_IDP_ISSUER
                             SAML sign-in, e.g. IAM Identity Center (see README)

AWS credentials come from the SDK default chain (AWS_PROFILE + aws sso login, instance/task roles, ...).
`;

const log = (message: string) => console.log(`${new Date().toISOString()}  ${message}`);

async function collect(config: MizarConfig, everyMinutes?: number) {
  const store = openStore(config);
  const run = async () => {
    const { meta, nodes, edges, durationMs } = await collectOnce(config, store, { log });
    log(`snapshot ${meta.id} saved — ${nodes} nodes, ${edges} edges, ${((meta.bytes ?? 0) / 1024).toFixed(0)} KB, ${durationMs} ms`);
  };

  log(`collecting from "${config.source}" into ${redactUrl(config.store)}`);
  if (!everyMinutes) return run();

  // Long-running mode for containers: sequential runs, so a slow collection never overlaps the next one.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => (stopping = true));
  while (!stopping) {
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      log(`collection failed: ${(error as Error).message}`);
    }
    const wait = Math.max(0, everyMinutes * 60_000 - (Date.now() - started));
    const until = Date.now() + wait;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
  }
  log("stopped");
}

/**
 * Runs the standalone Next.js server bundled next to this CLI. Without sign-in it listens on loopback only, whatever
 * HOSTNAME says: Mizar maps a whole estate and must not be reachable unauthenticated by accident.
 */
async function serve(config: MizarConfig) {
  const server = fileURLToPath(new URL("../server.js", import.meta.url));
  if (!existsSync(server)) {
    throw new Error("`mizar serve` runs the built server (Docker image). From source: npm run dev, or npm run build && npm start");
  }
  const { mode } = config.auth;
  if (mode === "localhost") {
    process.env.HOSTNAME = "127.0.0.1";
    log("no sign-in configured: listening on 127.0.0.1 only. Configure sign-in (auth.issuer, or auth.saml, ...) to serve " +
      "other machines, or set MIZAR_AUTH_MODE=none if something in front already authenticates users.");
  } else if (mode === "none") {
    log("auth mode \"none\": no sign-in. Anyone who can reach this server sees the whole map.");
  } else {
    log(`sign-in with ${mode === "saml" ? config.auth.saml.entryPoint : config.auth.issuer} at ${config.auth.publicUrl}`);
  }
  await import(pathToFileURL(server).href);
}

/** For authors of other collectors: the same checks the store applies on every read. */
function validate(files: string[]) {
  if (!files.length) throw new Error("Usage: mizar validate <file.json>...");
  for (const file of files) {
    let errors: string[];
    try {
      errors = checkSnapshot(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      errors = [(error as Error).message];
    }
    if (errors.length) process.exitCode = 1;
    console.log(errors.length ? `${file}: ${errors.length} problem(s)\n  ${errors.join("\n  ")}` : `${file}: valid`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string" },
      every: { type: "string" },
      scope: { type: "string" },
      accounts: { type: "string" },
      regions: { type: "string" },
      inventory: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  // Needs no configuration: works anywhere a snapshot file is.
  if (command === "validate") return validate(positionals.slice(1));

  const flags = {
    MIZAR_SOURCE: values.source,
    MIZAR_AWS_SCOPE: values.scope,
    MIZAR_AWS_ACCOUNTS: values.accounts,
    MIZAR_AWS_REGIONS: values.regions,
    MIZAR_AWS_INVENTORY: values.inventory,
  };
  const config = loadConfig({ ...process.env, ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) });

  switch (command) {
    case "collect": {
      const every = values.every === undefined ? undefined : Number(values.every);
      if (every !== undefined && !(every > 0)) throw new Error("--every must be a positive number of minutes");
      return collect(config, every);
    }
    case "snapshots": {
      const snapshots = await openStore(config).list(values.limit ? Number(values.limit) : 20);
      if (!snapshots.length) return console.log(`No snapshots in ${redactUrl(config.store)}. Run: mizar collect`);
      for (const s of snapshots) console.log(`${s.id}  ${s.generatedAt}  ${((s.bytes ?? 0) / 1024).toFixed(0)} KB`);
      return;
    }
    case "serve":
      return serve(config);
    case "config":
      return console.log(JSON.stringify(redactConfig(config), null, 2));
    default:
      throw new Error(`Unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((error: Error) => {
  console.error(`mizar: ${error.message}`);
  process.exitCode = 1;
});

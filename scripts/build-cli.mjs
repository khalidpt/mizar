// Bundles the CLI into one self-contained ES module (dependencies included), so the Docker image can run it with
// plain `node`, without tsx or a full node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["cli/mizar.ts"],
  outfile: "dist/cli/mizar.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Some bundled CommonJS dependencies (the AWS SDK) call `require` for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: "linked",
  logLevel: "info",
});

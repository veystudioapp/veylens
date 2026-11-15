import { parseArgs } from "node:util"

import * as esbuild from "esbuild"

/**
 * Bundles the main process and the preload into `dist-electron/`.
 *
 *   bun scripts/build-electron.mjs [--minify]
 */
const { values } = parseArgs({
  options: { minify: { type: "boolean", default: false } },
})

/** @type {import("esbuild").BuildOptions} */
const shared = {
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  target: "node22",
  // Electron loads these as CommonJS. The package is `"type": "module"`, so
  // the extension is what tells Node so.
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  // The database drivers carry dynamic requires esbuild cannot follow, so they
  // stay real packages resolved from node_modules.
  external: ["electron", "pg", "pg-cursor", "mysql2", "mysql2/promise"],
  sourcemap: true,
  minify: values.minify,
  logLevel: "info",
}

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: { main: "src/main/main.ts" },
    // The agent SDK is ESM and builds a `require` from `import.meta.url`,
    // which esbuild's CJS output would otherwise leave undefined.
    banner: {
      js: `const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
    },
    define: { "import.meta.url": "__importMetaUrl" },
  }),
  // Its own build: the preload is sandboxed and cannot take the banner's
  // `require("node:url")`.
  esbuild.build({
    ...shared,
    entryPoints: { preload: "src/preload/index.ts" },
  }),
])

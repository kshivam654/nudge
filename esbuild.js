const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// Matches the [watch] build started/finished lines .vscode/tasks.json's
// background problem matcher looks for, so `F5` knows when the first build
// (and each rebuild) is actually done rather than waiting forever.
const watchLogPlugin = {
  name: "watch-log",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode", "bufferutil", "utf-8-validate"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  plugins: [watchLogPlugin],
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  plugins: [watchLogPlugin],
};

async function main() {
  const contexts = await Promise.all([extensionConfig, webviewConfig].map((config) => esbuild.context(config)));

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[esbuild] watching for changes...");
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

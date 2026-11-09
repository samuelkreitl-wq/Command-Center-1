import { build } from "esbuild";

await build({
  entryPoints: ["server/prod.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist-server/index.js",
  packages: "external",
  sourcemap: true,
});

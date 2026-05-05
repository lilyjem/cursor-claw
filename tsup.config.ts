import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/cursor-claw.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
});

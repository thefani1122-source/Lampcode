import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  format: ["esm"],
  outDir: "dist",
  // tests/ is outside src/ and never bundled
  exclude: ["tests/**"],
});

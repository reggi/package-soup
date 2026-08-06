import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const shim = (name: string): string =>
  fileURLToPath(new URL(`./site/shims/${name}.ts`, import.meta.url));

export default defineConfig({
  root: "site",
  base: "./",
  resolve: {
    alias: {
      "node:path/win32": "path-browserify",
      "node:path": "path-browserify",
      "node:os": shim("node-os"),
      "node:url": shim("node-url"),
      url: shim("node-url"),
    },
  },
  define: {
    "process.cwd": "(() => '/')",
    "process.platform": JSON.stringify("browser"),
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    modulePreload: false,
    outDir: "../site-dist",
    emptyOutDir: true,
  },
});

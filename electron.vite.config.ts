import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Generated public assets are shared by the production bundle and dev server.
const publicRoot = resolve(".reader-assets");
const assets = resolve(publicRoot, "reader-assets");
mkdirSync(assets, { recursive: true });
cpSync("tests/fixtures", resolve(assets, "fixtures"), { recursive: true });
mkdirSync(resolve(assets, "foliate"), { recursive: true });
for (const name of readdirSync("vendor/foliate-js")) {
  if (name.endsWith(".js") || name === "vendor" || name.startsWith("LICENSE"))
    cpSync(`vendor/foliate-js/${name}`, resolve(assets, "foliate", name), {
      recursive: true,
    });
}
for (const name of ["build", "cmaps", "standard_fonts", "wasm", "LICENSE"]) {
  cpSync(`node_modules/pdfjs-dist/${name}`, resolve(assets, "pdf", name), {
    recursive: true,
  });
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    publicDir: publicRoot,
    build: {
      rollupOptions: {
        input: {
          shell: resolve("src/renderer/index.html"),
          content: resolve("src/renderer/content.html"),
          extract: resolve("src/renderer/extract.html"),
        },
      },
    },
    plugins: [
      react(),
      {
        name: "development-only-csp",
        apply: "serve",
        transformIndexHtml(html) {
          // Vite's React refresh preamble and style injection are development-only.
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
            .replace(
              "connect-src 'self'",
              "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
            );
        },
      },
    ],
  },
});

import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// `vite build --mode web` builds the standalone browser version (PWA) into
// dist-web/ for GitHub Pages. Any other mode builds the Tauri desktop UI.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    clearScreen: false,
    base: web ? "./" : "/",
    publicDir: web ? "web/public" : false,
    server: { port: web ? 1430 : 1420, strictPort: true },
    build: {
      target: ["es2022", "chrome100", "safari15"],
      outDir: web ? "dist-web" : "dist",
      emptyOutDir: true,
    },
    plugins: web ? [pwa()] : [],
  };
});

function pwa() {
  let isBuild = false;
  return {
    name: "pingtracker-pwa",
    configResolved(c) {
      isBuild = c.command === "build";
    },
    transformIndexHtml(html) {
      const head = `
    <meta name="description" content="Track your internet latency and packet loss over time, right in the browser." />
    <meta name="theme-color" content="#257de0" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="PingTracker" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" type="image/png" href="./icons/favicon-32.png" />
    <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`;
      const sw = isBuild
        ? `
    <script>
      if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
    </script>`
        : "";
      return html
        .replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"')
        .replace("</head>", `${head}\n  </head>`)
        .replace("</body>", `${sw}\n  </body>`);
    },
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const pub = ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
      const precache = ["./", ...[...files, ...pub].filter((f) => f !== "index.html").map((f) => `./${f}`)];
      const id = Date.now().toString(36);
      const src = readFileSync(new URL("./web/sw.template.js", import.meta.url), "utf8")
        .replace("__BUILD_ID__", id)
        .replace("__PRECACHE__", JSON.stringify(precache, null, 2));
      this.emitFile({ type: "asset", fileName: "sw.js", source: src });
    },
  };
}

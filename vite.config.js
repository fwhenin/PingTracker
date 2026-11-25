import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: ["es2022", "chrome100", "safari15"], outDir: "dist", emptyOutDir: true },
});

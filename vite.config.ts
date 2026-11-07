import { defineConfig } from "vite";

// Fixed public-data upstreams only; never accept arbitrary proxy targets.
const proxy = {
  "/api/kraken": {
    target: "https://api.kraken.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/kraken/, "/0/public"),
    timeout: 12000,
    proxyTimeout: 12000,
  },
  "/api/kalshi": {
    target: "https://api.elections.kalshi.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/kalshi/, "/trade-api/v2"),
    timeout: 12000,
    proxyTimeout: 12000,
  },
};

export default defineConfig({
  root: "money-os-desk",
  server: { host: "0.0.0.0", port: 5000, strictPort: true, allowedHosts: true, proxy },
  preview: { host: "0.0.0.0", port: 5000, strictPort: true, allowedHosts: true, proxy },
  build: { outDir: "../dist", emptyOutDir: true },
});


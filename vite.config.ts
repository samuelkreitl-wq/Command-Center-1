import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

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

const apiPrefixes = ["/api/trade", "/api/paper", "/api/learning", "/api/health", "/api/safety-net", "/api/forecast", "/api/desk", "/api/test"];

function deskApi(): Plugin {
  return {
    name: "desk-api",
    configureServer(server) {
      let started = false;
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || "").split("?")[0];
        if (!apiPrefixes.some((prefix) => path.startsWith(prefix))) return next();
        try {
          const mod = await server.ssrLoadModule(resolve("server/http.ts")) as {
            dispatch: (request: typeof req, response: typeof res) => Promise<boolean>;
            startBackground: () => void;
          };
          if (!started) {
            started = true;
            mod.startBackground();
          }
          await mod.dispatch(req, res);
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "desk api failed" }));
        }
      });
    },
  };
}

export default defineConfig({
  root: "money-os-desk",
  plugins: [deskApi()],
  server: { host: "0.0.0.0", port: 5000, strictPort: true, allowedHosts: true, proxy },
  preview: { host: "0.0.0.0", port: 5000, strictPort: true, allowedHosts: true, proxy },
  build: { outDir: "../dist", emptyOutDir: true },
});


import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const childPath = join(root, "dist-server", "index.js");

function launch() {
  const child = spawn(process.execPath, [childPath], { stdio: "inherit", env: process.env, cwd: root });
  child.on("exit", (code, signal) => {
    if (signal === "SIGINT" || signal === "SIGTERM" || code === 0) {
      process.exit(code ?? 0);
    }
    console.error(`desk process exited (${code ?? signal}). Restarting in 1s.`);
    setTimeout(launch, 1000);
  });
  const stop = (signal) => child.kill(signal);
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

launch();

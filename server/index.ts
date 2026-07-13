import { execFile } from "node:child_process";
import { createApp, createServices } from "./app.js";

const port = Number(process.env.DSBOX_PORT || 4242);
const host = process.env.DSBOX_HOST || "127.0.0.1";

if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("DSBox rifiuta il bind non-loopback: usa un tunnel SSH invece di esporre il control plane.");
}

const services = await createServices(port);
const app = createApp(services);
const server = app.listen(port, host, () => {
  services.runtime.log("success", "dsbox", `DSBox pronto su http://${host}:${port}`);
  services.metrics.start();
  if (process.env.DSBOX_OPEN_BROWSER === "1" && process.platform === "darwin") {
    execFile("open", [`http://${host}:${port}`], () => undefined);
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  services.metrics.stop();
  if (services.runtime.hasTask()) {
    try {
      services.runtime.cancelTask();
    } catch {
      // Task may have exited between the check and the signal.
    }
  }
  if (services.runtime.getPid()) {
    try {
      await services.runtime.stop();
    } catch {
      // The OS will finish process teardown after the control plane exits.
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

import { execFile } from "node:child_process";
import { createApp, createServices } from "./app.js";

const port = Number(process.env.DSBOX_PORT || 4242);
const host = process.env.DSBOX_HOST || "127.0.0.1";

if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("Hebrus Studio refuses non-loopback binding. Use an SSH tunnel instead of exposing the control plane.");
}

const services = await createServices(port);
const app = createApp(services);
const server = app.listen(port, host, (error?: Error) => {
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(
      `Hebrus Studio could not listen on http://${host}:${port}${code ? ` (${code})` : ""}: ${error.message}\n`
    );
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
    return;
  }
  services.runtime.log("success", "dsbox", `Hebrus Studio is ready at http://${host}:${port}`);
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
      await services.runtime.cancelTask();
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
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 20_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

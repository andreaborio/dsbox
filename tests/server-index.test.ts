import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  return await new Promise<ChildExit>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Hebrus Studio did not exit within ${timeoutMs}ms after a port conflict`));
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("Hebrus Studio server entrypoint", () => {
  it("exits non-zero instead of starting metrics when the control port is occupied", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "dsbox-port-conflict-"));
    const blocker = createServer();
    let child: ChildProcess | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const address = blocker.address();
      if (!address || typeof address === "string") throw new Error("Port blocker did not bind");

      child = spawn(
        process.execPath,
        [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("server/index.ts")],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DSBOX_HOME: home,
            DSBOX_HOST: "127.0.0.1",
            DSBOX_PORT: String(address.port),
            DSBOX_OPEN_BROWSER: "0"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

      const exit = await waitForExit(child, 5_000);

      expect(exit).toEqual({ code: 1, signal: null });
      expect(stderr).toContain(`Hebrus Studio could not listen on http://127.0.0.1:${address.port}`);
      expect(stderr).toContain("EADDRINUSE");
      expect(`${stdout}\n${stderr}`).not.toContain("Hebrus Studio is ready");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closeServer(blocker);
      await rm(home, { recursive: true, force: true });
    }
  });
});

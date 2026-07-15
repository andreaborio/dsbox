import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { CONTENT_SECURITY_POLICY } from "./server/security.js";

const DEFAULT_DSBOX_PORT = 4242;

export function resolveDsboxDevProxyTarget(rawPort?: string): string {
  const value = rawPort?.trim();
  if (!value) return `http://127.0.0.1:${DEFAULT_DSBOX_PORT}`;
  if (!/^\d+$/.test(value)) throw new Error("DSBOX_PORT must be an integer between 1 and 65535.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DSBOX_PORT must be an integer between 1 and 65535.");
  }
  return `http://127.0.0.1:${port}`;
}

export default defineConfig(() => {
  const proxyTarget = resolveDsboxDevProxyTarget(process.env.DSBOX_PORT);
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      headers: {
        "Content-Security-Policy": CONTENT_SECURITY_POLICY
      },
      proxy: {
        "/api": proxyTarget,
        "/v1": proxyTarget
      }
    },
    build: {
      sourcemap: true
    }
  };
});

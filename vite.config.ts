import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { CONTENT_SECURITY_POLICY } from "./server/security.js";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Content-Security-Policy": CONTENT_SECURITY_POLICY
    },
    proxy: {
      "/api": "http://127.0.0.1:4242",
      "/v1": "http://127.0.0.1:4242"
    }
  },
  build: {
    sourcemap: true
  }
});

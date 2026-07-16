import { describe, expect, it } from "vitest";
import { REACT_REFRESH_PREAMBLE_URL, reactRefreshPreambleTags, resolveDsboxDevProxyTarget } from "../vite.config.js";

describe("Vite DSBox proxy target", () => {
  it("uses the production-compatible control port by default", () => {
    expect(resolveDsboxDevProxyTarget(undefined)).toBe("http://127.0.0.1:4242");
    expect(resolveDsboxDevProxyTarget("   ")).toBe("http://127.0.0.1:4242");
  });

  it("routes development API traffic to the configured DSBOX_PORT", () => {
    expect(resolveDsboxDevProxyTarget("4302")).toBe("http://127.0.0.1:4302");
    expect(resolveDsboxDevProxyTarget(" 5174 ")).toBe("http://127.0.0.1:5174");
  });

  it.each(["0", "65536", "4242.5", "not-a-port", "4242/path"])("rejects unsafe DSBOX_PORT=%s", (value) => {
    expect(() => resolveDsboxDevProxyTarget(value)).toThrow("DSBOX_PORT must be an integer between 1 and 65535.");
  });
});

describe("Vite development CSP", () => {
  it("loads the React refresh preamble from the same origin instead of requiring inline scripts", () => {
    expect(reactRefreshPreambleTags()).toEqual([{
      tag: "script",
      attrs: { type: "module", src: REACT_REFRESH_PREAMBLE_URL },
      injectTo: "head-prepend"
    }]);
  });
});

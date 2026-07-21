#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { extractFile } = require("@electron/asar");
const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(repoRoot, "tests", "fixtures", "legacy-v0.3.2-state.json");
const CONTROL_HEADER = { "x-dsbox-control": "1" };
const BUNDLE_ID = "com.dsbox.desktop";
const DEFAULT_TIMEOUT_MS = 30_000;

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-upgrade-rollback-e2e.mjs \\",
    "    --old-app /path/to/DSBox.app \\",
    "    --new-app '/path/to/Hebrus Studio.app'",
    "",
    "Options:",
    "  --keep-temp          Preserve the disposable profile and state directory.",
    "  --timeout-ms <ms>    Per-phase startup timeout (default: 30000)."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    oldApp: process.env.DSBOX_UPGRADE_E2E_OLD_APP || "",
    newApp: process.env.DSBOX_UPGRADE_E2E_NEW_APP || "",
    keepTemp: process.env.DSBOX_UPGRADE_E2E_KEEP_TEMP === "1",
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--old-app") options.oldApp = argv[++index] || "";
    else if (argument === "--new-app") options.newApp = argv[++index] || "";
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (argument === "--keep-temp") options.keepTemp = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  if (!options.oldApp || !options.newApp) throw new Error(usage());
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  options.oldApp = path.resolve(options.oldApp);
  options.newApp = path.resolve(options.newApp);
  return options;
}

async function plistValue(appPath, key) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
  return stdout.trim();
}

async function inspectPackage(appPath, expected) {
  assert((await stat(appPath)).isDirectory(), `${appPath} is not an app bundle`);
  const bundleId = await plistValue(appPath, "CFBundleIdentifier");
  const executableName = await plistValue(appPath, "CFBundleExecutable");
  const productName = await plistValue(appPath, "CFBundleName");
  const version = await plistValue(appPath, "CFBundleShortVersionString");
  assert.equal(bundleId, BUNDLE_ID, `${expected.label} changed the compatibility bundle id`);
  assert.equal(executableName, expected.executable, `${expected.label} has the wrong executable name`);
  assert.equal(productName, expected.productName, `${expected.label} has the wrong product name`);
  if (expected.version) assert.equal(version, expected.version, `${expected.label} has the wrong package version`);
  const executable = path.join(appPath, "Contents", "MacOS", executableName);
  assert((await stat(executable)).isFile(), `${expected.label} executable is missing`);
  const { stdout: architectures } = await execFile("/usr/bin/lipo", ["-archs", executable]);
  assert.match(architectures, /(?:^|\s)arm64(?:\s|$)/, `${expected.label} is not arm64`);
  return { ...expected, appPath, bundleId, executable, version };
}

function packagedMain(appPath) {
  const archivePath = path.join(appPath, "Contents", "Resources", "app.asar");
  return extractFile(archivePath, "desktop/main.cjs").toString("utf8");
}

async function freePort(reserved) {
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Could not reserve a loopback port"));
          return;
        }
        const candidate = address.port;
        server.close((error) => error ? reject(error) : resolve(candidate));
      });
    });
    if (port !== 8000 && !reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}

async function waitForJson(url, predicate, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Packaged app exited before ${url} became ready (exit ${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(900) });
      if (response.ok) {
        const value = await response.json();
        if (!predicate || predicate(value)) return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForPage(debugPort, controlPort, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      Array.isArray,
      Math.min(1_000, Math.max(100, deadline - Date.now())),
      child
    ).catch(() => []);
    const target = targets.find((candidate) => (
      candidate.type === "page"
      && candidate.url?.startsWith(`http://127.0.0.1:${controlPort}/`)
      && candidate.webSocketDebuggerUrl
    ));
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the renderer DevTools target on ${debugPort}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`Could not connect to ${this.url}`)), { once: true });
    });
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function apiJson(port, route, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json", ...CONTROL_HEADER } : {}),
      ...init.headers
    }
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `${init.method || "GET"} ${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function browserStorageExpression(values) {
  return `(() => {
    const values = ${JSON.stringify(values)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    return Object.fromEntries(Object.keys(values).map((key) => [key, localStorage.getItem(key)]));
  })()`;
}

function readBrowserStorageExpression(keys) {
  return `Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, localStorage.getItem(key)]))`;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Control port ${port} remained open after the packaged app exited`);
}

async function withPackagedApp(spec, context, operation) {
  const output = [];
  const child = spawn(spec.executable, [
    `--user-data-dir=${context.profilePath}`,
    `--remote-debugging-port=${context.debugPort}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    env: {
      ...process.env,
      HOME: context.osHome,
      TMPDIR: context.tempRoot,
      DSBOX_HOME: context.stateHome,
      DSBOX_PORT: String(context.controlPort),
      DSBOX_OPEN_BROWSER: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  let cdp = null;
  let operationError = null;
  try {
    const health = await waitForJson(
      `http://127.0.0.1:${context.controlPort}/api/health`,
      (value) => value?.ok === true,
      context.timeoutMs,
      child
    );
    const target = await waitForPage(context.debugPort, context.controlPort, context.timeoutMs, child);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.evaluate("new Promise((resolve) => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), { once: true }))");
    return await operation({ cdp, health, child });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (cdp && child.exitCode === null) {
      try {
        await cdp.evaluate("window.close(); true");
      } catch {
        // Closing the renderer may tear down the DevTools socket before a reply.
      }
    }
    cdp?.close();
    let exit = await waitForExit(child, 10_000);
    if (!exit) {
      child.kill("SIGTERM");
      exit = await waitForExit(child, 5_000);
      if (!exit) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
      if (!operationError) {
        throw new Error(`${spec.label} did not shut down through its packaged window lifecycle`);
      }
    } else if (!operationError && exit.code !== 0) {
      throw new Error(`${spec.label} exited with ${exit.code ?? exit.signal}`);
    }
    await waitForPortClosed(context.controlPort, 5_000).catch((error) => {
      if (!operationError) throw error;
    });
    if (operationError || !exit || exit.code !== 0) {
      const logPath = path.join(context.tempRoot, `${context.phase}.log`);
      await writeFile(logPath, Buffer.concat(output).toString("utf8"));
      console.error(`${spec.label} log: ${logPath}`);
    }
  }
}

function createConfig(stateHome, modelPath, enginePort) {
  return {
    version: 2,
    repository: {
      url: "https://github.com/andreaborio/ds4.git",
      branch: "main",
      directory: path.join(stateHome, "runtime", "andreaborio-ds4")
    },
    model: { path: modelPath, id: "upgrade-rollback-model" },
    server: {
      internalHost: "127.0.0.1",
      internalPort: enginePort,
      contextTokens: 8192,
      maxOutputTokens: 4096,
      powerPercent: 73,
      threads: 5,
      prefillChunk: null,
      quality: false,
      warmWeights: false
    },
    streaming: {
      enabled: true,
      cacheMode: "manual",
      cacheSizeGb: 7,
      coldStart: true,
      preloadExperts: null
    },
    kvCache: {
      enabled: true,
      directory: path.join(stateHome, "cache", "kv"),
      spaceMb: 1024,
      minTokens: 256,
      continuedIntervalTokens: 4096
    },
    observability: {
      traceEnabled: false,
      tracePath: path.join(stateHome, "logs", "ds4.trace"),
      imatrixEnabled: false,
      imatrixPath: path.join(stateHome, "imatrix", "live-imatrix.dat"),
      imatrixEvery: 64
    },
    gateway: { requireApiKey: false, apiKey: "dsbox-upgrade-e2e-key" },
    advanced: { extraArgs: "", environment: "UPGRADE_E2E_STAGE=fixture" }
  };
}

function createDownloadState(stateHome) {
  const stagingDirectory = path.join(stateHome, "models", "upgrade-e2e.partial");
  const now = "2026-07-21T00:00:00.000Z";
  return {
    version: 1,
    downloads: [{
      version: 1,
      assembly: null,
      stagingDirectory,
      snapshot: {
        id: "upgrade-e2e-download",
        repository: "example/upgrade-e2e-model",
        revision: "a".repeat(40),
        variantId: "legacy-q2",
        variantLabel: "Legacy Q2",
        modelId: "upgrade-rollback-model",
        label: "Upgrade rollback fixture",
        stage: "cancelled",
        files: [{
          name: "fixture.gguf",
          sizeBytes: 64,
          sha256: null,
          downloadedBytes: 0,
          stage: "pending"
        }],
        outputFile: "fixture.gguf",
        totalBytes: 64,
        downloadedBytes: 0,
        speedBytesPerSecond: 0,
        etaSeconds: null,
        destinationDirectory: path.join(stateHome, "models", "upgrade-e2e"),
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        error: null,
        disk: { availableBytes: null, requiredBytes: 0, shortfallBytes: 0 }
      }
    }]
  };
}

async function assertPersistedFiles(stateHome, modelPath, expectedEnvironment) {
  const config = JSON.parse(await readFile(path.join(stateHome, "config.json"), "utf8"));
  assert.equal(config.version, 2);
  assert.equal(config.model.path, modelPath);
  assert.equal(config.model.id, "upgrade-rollback-model");
  assert.equal(config.server.internalPort === 8000, false, "the E2E must never target port 8000");
  assert.equal(config.advanced.environment, expectedEnvironment);

  const inventory = JSON.parse(await readFile(path.join(stateHome, "local-models.json"), "utf8"));
  assert.equal(inventory.version, 1);
  assert(inventory.models.some((model) => model.path === modelPath && model.modelId === "upgrade-rollback-model"));

  const downloads = JSON.parse(await readFile(path.join(stateHome, "downloads", "state.json"), "utf8"));
  assert.equal(downloads.version, 1);
  assert.equal(downloads.downloads[0]?.snapshot?.id, "upgrade-e2e-download");
  assert.equal(downloads.downloads[0]?.snapshot?.stage, "cancelled");
}

async function assertRuntimeState(controlPort, modelPath, expectedEnvironment) {
  const state = await apiJson(controlPort, "/api/state");
  assert.equal(state.config.model.path, modelPath);
  assert.equal(state.config.model.id, "upgrade-rollback-model");
  assert.equal(state.config.advanced.environment, expectedEnvironment);
  assert.equal(state.config.server.internalPort === 8000, false);
  assert.equal(state.runtime.pid, null, "the E2E must not start inference");
  assert.notEqual(state.runtime.phase, "running", "the E2E must not start inference");

  const downloads = await apiJson(controlPort, "/api/models/downloads");
  assert.equal(downloads.downloads[0]?.id, "upgrade-e2e-download");
  assert.equal(downloads.downloads[0]?.stage, "cancelled");

  const local = await apiJson(controlPort, "/api/models/local");
  assert(local.models.some((model) => model.path === modelPath && model.modelId === "upgrade-rollback-model"));
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This packaged-app E2E requires macOS on Apple Silicon");
  }
  const options = parseArgs(process.argv.slice(2));
  const oldPackage = await inspectPackage(options.oldApp, {
    label: "DSBox 0.3.2",
    executable: "DSBox",
    productName: "DSBox",
    version: "0.3.2"
  });
  const newPackage = await inspectPackage(options.newApp, {
    label: "Hebrus Studio",
    executable: "Hebrus Studio",
    productName: "Hebrus Studio"
  });
  assert.equal(oldPackage.bundleId, newPackage.bundleId);

  const newMain = packagedMain(options.newApp);
  assert.match(newMain, /app\.getPath\(["']appData["']\)/, "packaged Hebrus Studio does not derive its default profile from appData");
  assert.match(newMain, /["']DSBox["']/, "packaged Hebrus Studio no longer pins the legacy DSBox profile name");
  assert.match(newMain, /app\.setPath\(["']userData["']/, "packaged Hebrus Studio does not pin userData before ready");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hebrus-upgrade-rollback-"));
  const osHome = path.join(tempRoot, "home");
  const stateHome = path.join(osHome, ".dsbox");
  const profilePath = path.join(tempRoot, "electron-profile", "DSBox");
  const modelPath = path.join(stateHome, "models", "upgrade-e2e.gguf");
  const reserved = new Set([8000]);
  const enginePort = await freePort(reserved);
  // localStorage is origin-scoped, so all three sequential launches must use
  // one isolated control origin. Each renderer gets a distinct DevTools port.
  const controlPort = await freePort(reserved);
  const debugPorts = [];
  for (let index = 0; index < 3; index += 1) debugPorts.push(await freePort(reserved));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const originalBrowserStorage = fixture.browserStorage;
  const browserKeys = Object.keys(originalBrowserStorage);
  const upgradedBrowserStorage = {
    ...originalBrowserStorage,
    "dsbox:last-view:v1": "settings"
  };
  const oldEnvironment = "UPGRADE_E2E_STAGE=DSBOX_CREATED";
  const newEnvironment = `${oldEnvironment}\nUPGRADE_E2E_STAGE=HEBRUS_STUDIO_UPDATED`;

  await mkdir(path.dirname(modelPath), { recursive: true });
  await mkdir(path.join(stateHome, "downloads"), { recursive: true });
  await mkdir(profilePath, { recursive: true });
  await writeFile(modelPath, Buffer.from("GGUF-upgrade-rollback-fixture"));
  await writeFile(path.join(stateHome, "config.json"), `${JSON.stringify(createConfig(stateHome, modelPath, enginePort), null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(stateHome, "local-models.json"), `${JSON.stringify({
    version: 1,
    models: [{ path: modelPath, modelId: "upgrade-rollback-model" }]
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(stateHome, "downloads", "state.json"), `${JSON.stringify(createDownloadState(stateHome), null, 2)}\n`, { mode: 0o600 });

  console.log(`Disposable root: ${tempRoot}`);
  let succeeded = false;
  try {
    console.log("[1/3] Launching packaged DSBox and creating legacy persisted state...");
    await withPackagedApp(oldPackage, {
      phase: "dsbox-create",
      controlPort,
      debugPort: debugPorts[0],
      profilePath,
      stateHome,
      osHome,
      tempRoot,
      timeoutMs: options.timeoutMs
    }, async ({ cdp, health }) => {
      assert.equal(health.version, oldPackage.version);
      await assertRuntimeState(controlPort, modelPath, "UPGRADE_E2E_STAGE=fixture");
      assert.deepEqual(await cdp.evaluate(browserStorageExpression(originalBrowserStorage)), originalBrowserStorage);
      const state = await apiJson(controlPort, "/api/state");
      const updated = structuredClone(state.config);
      updated.advanced.environment = oldEnvironment;
      const saved = await apiJson(controlPort, "/api/config", {
        method: "PUT",
        body: JSON.stringify(updated)
      });
      assert.equal(saved.advanced.environment, oldEnvironment);
    });
    await assertPersistedFiles(stateHome, modelPath, oldEnvironment);

    console.log("[2/3] Launching packaged Hebrus Studio against the same state...");
    await withPackagedApp(newPackage, {
      phase: "hebrus-upgrade",
      controlPort,
      debugPort: debugPorts[1],
      profilePath,
      stateHome,
      osHome,
      tempRoot,
      timeoutMs: options.timeoutMs
    }, async ({ cdp, health }) => {
      assert.equal(health.version, newPackage.version);
      await assertRuntimeState(controlPort, modelPath, oldEnvironment);
      assert.deepEqual(await cdp.evaluate(readBrowserStorageExpression(browserKeys)), originalBrowserStorage);
      assert.deepEqual(await cdp.evaluate(browserStorageExpression(upgradedBrowserStorage)), upgradedBrowserStorage);
      const state = await apiJson(controlPort, "/api/state");
      const updated = structuredClone(state.config);
      updated.advanced.environment = newEnvironment;
      const saved = await apiJson(controlPort, "/api/config", {
        method: "PUT",
        body: JSON.stringify(updated)
      });
      assert.equal(saved.advanced.environment, newEnvironment);
    });
    await assertPersistedFiles(stateHome, modelPath, newEnvironment);

    console.log("[3/3] Rolling back to packaged DSBox against the Hebrus-touched state...");
    await withPackagedApp(oldPackage, {
      phase: "dsbox-rollback",
      controlPort,
      debugPort: debugPorts[2],
      profilePath,
      stateHome,
      osHome,
      tempRoot,
      timeoutMs: options.timeoutMs
    }, async ({ cdp, health }) => {
      assert.equal(health.version, oldPackage.version);
      await assertRuntimeState(controlPort, modelPath, newEnvironment);
      assert.deepEqual(await cdp.evaluate(readBrowserStorageExpression(browserKeys)), upgradedBrowserStorage);
    });
    await assertPersistedFiles(stateHome, modelPath, newEnvironment);

    const topLevelState = await readdir(stateHome);
    assert(topLevelState.includes("config.json"));
    assert(topLevelState.includes("local-models.json"));
    assert(topLevelState.includes("downloads"));
    await assert.rejects(stat(path.join(osHome, ".hebrus")), { code: "ENOENT" });

    console.log("PASS: packaged DSBox -> Hebrus Studio -> DSBox rollback preserved:");
    console.log("  - com.dsbox.desktop bundle identity and legacy DSBox userData contract");
    console.log("  - ~/.dsbox config, local-model inventory, and download state");
    console.log("  - dsbox:* theme, onboarding, view, model disclosure, and chat keys");
    console.log("  - model-free operation with one packaged process at a time and no port 8000 use");
    succeeded = true;
  } finally {
    if (options.keepTemp || !succeeded) console.log(`Preserved disposable evidence at ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CONTROL_HOST = "127.0.0.1";
const CONTROL_PORT = Number(process.env.DSBOX_PORT || 4242);
const CONTROL_ORIGIN = `http://${CONTROL_HOST}:${CONTROL_PORT}`;

let mainWindow = null;
let httpServer = null;
let services = null;
let ownsControlPlane = false;
let quitAfterShutdown = false;
let shutdownPromise = null;

app.setName("DSBox");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function isSafeExternalUrl(rawUrl) {
  try {
    return ["http:", "https:"].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

async function existingControlPlaneIsReady() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${CONTROL_ORIGIN}/api/health`, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function startEmbeddedControlPlane() {
  if (await existingControlPlaneIsReady()) return;

  const serverModulePath = path.join(app.getAppPath(), "dist-server", "server", "app.js");
  const { createApp, createServices } = await import(pathToFileURL(serverModulePath).href);
  services = await createServices(CONTROL_PORT);
  const expressApp = createApp(services);
  httpServer = await new Promise((resolve, reject) => {
    const server = expressApp.listen(CONTROL_PORT, CONTROL_HOST, () => resolve(server));
    server.once("error", reject);
  });
  ownsControlPlane = true;
  services.runtime.log("success", "dsbox", `DSBox desktop is ready at ${CONTROL_ORIGIN}`);
  services.metrics.start();
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "DSBox",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" }
  ]));
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#f7f7f5",
    title: "DSBox",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 17 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${CONTROL_ORIGIN}/`)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(`${CONTROL_ORIGIN}/?desktop=1`);
  mainWindow = window;
  return window;
}

async function shutdownOwnedControlPlane() {
  if (!ownsControlPlane || !services || !httpServer) return;
  services.metrics.stop();
  if (services.runtime.hasTask()) await services.runtime.cancelTask().catch(() => undefined);
  if (services.runtime.getPid()) await services.runtime.stop().catch(() => undefined);
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(() => resolve()));
  ownsControlPlane = false;
  httpServer = null;
  services = null;
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) createMainWindow();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    installApplicationMenu();
    app.setAboutPanelOptions({ applicationName: "DSBox", applicationVersion: app.getVersion(), copyright: "Local AI on Apple Silicon" });
    try {
      await startEmbeddedControlPlane();
      createMainWindow();
    } catch (error) {
      dialog.showErrorBox("DSBox could not start", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on("activate", () => { if (!mainWindow) createMainWindow(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitAfterShutdown || !ownsControlPlane) return;
    event.preventDefault();
    if (!shutdownPromise) {
      shutdownPromise = shutdownOwnedControlPlane().finally(() => {
        quitAfterShutdown = true;
        app.quit();
      });
    }
  });
}

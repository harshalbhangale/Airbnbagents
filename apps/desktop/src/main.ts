import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { HostApp } from "../../worker/src/app.ts";
import { startDashboard, type Dashboard } from "../../worker/src/dashboard/server.ts";
import { rpcSettlementVerifier } from "../../worker/src/settlement.ts";
import { ElectronSiteBrowser } from "./electron-browser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXPLORER = /^https:\/\/(sepolia\.)?basescan\.org\/tx\/0x[0-9a-f]{64}$/;

if (process.env.AGENTBNB_USER_DATA) app.setPath("userData", process.env.AGENTBNB_USER_DATA);

/**
 * Where to connect. Environment variables win, then `config.json` in the
 * app's data folder, then the local demo set-up.
 */
function settings(): { marketplaceUrl: string; siteOrigin: string } {
  let file: { marketplaceUrl?: unknown; siteOrigin?: unknown } = {};
  const path = join(app.getPath("userData"), "config.json");
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* unreadable settings: fall back to the defaults */
    }
  }
  const pick = (env: string | undefined, saved: unknown, fallback: string) => env || (typeof saved === "string" && saved ? saved : fallback);
  return {
    marketplaceUrl: pick(process.env.AGENTBNB_MARKETPLACE_URL, file.marketplaceUrl, "ws://127.0.0.1:4200/hosts/connect"),
    siteOrigin: pick(process.env.AGENTBNB_SITE_ORIGIN, file.siteOrigin, "http://127.0.0.1:4100"),
  };
}

let host: HostApp | null = null;
let dashboard: Dashboard | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function showWindow(): void {
  if (!dashboard) return;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 420,
    title: "agentbnb",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const origin = dashboard.origin;
  // The dashboard window only ever shows the dashboard. Payment links open in the host's own browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (EXPLORER.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.on("close", (event) => {
    // Closing the window leaves the host online; quitting is done from the tray or the app menu.
    if (!quitting && tray) {
      event.preventDefault();
      window?.hide();
    }
  });
  // With no tray to come back from, closing the dashboard is how the host quits.
  window.on("closed", () => {
    if (!tray && !quitting) app.quit();
  });
  void window.loadURL(dashboard.url);
}

function buildTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(join(here, "tray.png")));
  } catch {
    tray = null;
    return;
  }
  const refresh = () => {
    if (!tray || !host) return;
    const paused = host.worker.paused;
    tray.setToolTip(paused ? "agentbnb: paused" : "agentbnb: online");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open dashboard", click: showWindow },
        {
          label: paused ? "Resume" : "Pause everything",
          click: () => {
            if (!host) return;
            if (host.worker.paused) host.worker.resume();
            else host.worker.pause();
            host.announce();
            refresh();
          },
        },
        { type: "separator" },
        { label: "Quit agentbnb", click: () => app.quit() },
      ]),
    );
  };
  tray.on("click", showWindow);
  refresh();
  setInterval(refresh, 3_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  // The app opens and closes hidden windows for rented tasks all the time, so "no windows open"
  // says nothing about whether the host is done. Quitting is decided by the dashboard window and the tray.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      await dashboard?.close().catch(() => undefined);
      await host?.close().catch(() => undefined);
      app.exit(0);
    })();
  });

  void app.whenReady().then(async () => {
    const { marketplaceUrl, siteOrigin } = settings();
    host = await HostApp.start({
      dataDir: join(app.getPath("userData"), "host"),
      siteOrigin,
      marketplaceUrl,
      createBrowser: (options) => ElectronSiteBrowser.launch(options),
      verifySettlement: process.env.AGENTBNB_VERIFY_SETTLEMENTS === "off" ? undefined : rpcSettlementVerifier(),
    });
    dashboard = await startDashboard(host, { assetsDir: join(here, "public") });
    buildTray();
    showWindow();
  });
}

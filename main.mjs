import { app, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, stop } from "./server.mjs";

const { autoUpdater } = createRequire(import.meta.url)("electron-updater");

const ikon = join(dirname(fileURLToPath(import.meta.url)), "build", "icon.ico");

const PORT = Number(process.env.PORT || 3855);
let pencere;
let guncellemeKuruluyor = false;

function guncellemeyiIzle() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", () => {
    if (guncellemeKuruluyor) return;
    guncellemeKuruluyor = true;
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
  });
  autoUpdater.on("error", () => {});
  autoUpdater.checkForUpdates().catch(() => {});
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!pencere) return;
    if (pencere.isMinimized()) pencere.restore();
    pencere.show();
    pencere.focus();
  });

  app.setAppUserModelId("com.expertbilisim.xmlaktarim");
  app.whenReady().then(async () => {
    let port = PORT;
    try {
      port = await start(PORT);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }

    pencere = new BrowserWindow({
      width: 980,
      height: 880,
      minWidth: 460,
      minHeight: 680,
      title: "XML Aktarım",
      icon: ikon,
      backgroundColor: "#e7f1f8",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    pencere.once("ready-to-show", () => pencere.show());
    await pencere.loadURL(`http://127.0.0.1:${port}/`);
    guncellemeyiIzle();
  });

  app.on("window-all-closed", () => {
    stop().finally(() => app.quit());
  });
}

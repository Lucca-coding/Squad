const { app, BrowserWindow, session, desktopCapturer, Menu } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 750, backgroundColor: "#0b0b12", title: "SQUAD", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(["media", "display-capture", "clipboard-sanitized-write"].includes(perm)));

  // O Electron não mostra seletor de tela sozinho: abrimos um menu com telas e janelas
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
    let chosen = false;
    const menu = Menu.buildFromTemplate(sources.map((s) => ({
      label: s.name,
      click: () => {
        chosen = true;
        cb({ video: s, ...(process.platform === "win32" ? { audio: "loopback" } : {}) });
      },
    })));
    menu.popup({ callback: () => setTimeout(() => { if (!chosen) cb({}); }, 200) });
  });

  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

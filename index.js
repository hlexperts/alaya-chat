import { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut, shell, session } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import Store from "electron-store";
import { OpenPanel } from '@openpanel/sdk';
import { randomUUID } from 'crypto';
import isDev from 'electron-is-dev';
import {
  DEFAULT_HOST,
  PARTITION,
  PROTOCOL,
  normalizeServerHost,
  parseAuthDeepLink,
  ensureDesktopParam,
  isExternalOAuthUrl,
  exchangeDesktopOtt,
  applySessionCookies,
  findDeepLinkInArgv,
} from './desktop-auth.js';

// Fix for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const store = new Store();

const platformMap = {
  darwin: 'mac',
  win32: 'win',
  linux: 'linux'
};

app.disableHardwareAcceleration();

let mainWindow = null;
let loginWindow = null;
let authDeepLinkInFlight = false;

let opClient = null;

if (!isDev) {
  const clientId = process.env.OPENPANEL_CLIENT_ID;
  const clientSecret = process.env.OPENPANEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Error: OPENPANEL_CLIENT_ID or OPENPANEL_CLIENT_SECRET is not defined in the environment variables."
    );
  } else {
    opClient = new OpenPanel({
      clientId: clientId,
      clientSecret: clientSecret,
    });

    opClient.setGlobalProperties({
      app_version: app.getVersion(),
      environment: isDev ? "development" : "production",
    });
    opClient.identify({
      profileId: getUniqueComputerId(),
    });
  }
}

function getUniqueComputerId() {
  let computerId = store.get('computerId');

  if (!computerId) {
    computerId = randomUUID();
    store.set('computerId', computerId);
  }

  return computerId;
}

function getServerHost() {
  return normalizeServerHost(store.get('serverHost') || DEFAULT_HOST);
}

function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
      return;
    }
  }
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function openOAuthExternally(url) {
  const externalUrl = isExternalOAuthUrl(url) && url.includes('/oauth/google')
    ? ensureDesktopParam(url)
    : url;
  shell.openExternal(externalUrl);
}

function attachOAuthExternalHandlers(win) {
  const maybeExternal = (url) => {
    if (!isExternalOAuthUrl(url)) return false;
    openOAuthExternally(url);
    return true;
  };

  win.webContents.on('will-navigate', (event, url) => {
    if (maybeExternal(url)) event.preventDefault();
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (maybeExternal(url)) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (maybeExternal(url)) return { action: 'deny' };
    return { action: 'allow' };
  });
}

async function handleAuthDeepLink(url) {
  const parsed = parseAuthDeepLink(url);
  if (!parsed) {
    console.warn('Ignoring unrecognized deep link:', url);
    return;
  }
  if (authDeepLinkInFlight) {
    console.warn('Auth deep link already in progress; ignoring duplicate');
    return;
  }

  authDeepLinkInFlight = true;
  try {
    const serverHost = getServerHost();
    const tokens = await exchangeDesktopOtt({
      serverHost,
      token: parsed.token,
      state: parsed.state,
    });

    if (!tokens?.refreshToken) {
      throw new Error('exchange response missing refreshToken');
    }

    const ses = session.fromPartition(PARTITION);
    // Discovery: access JWT is not a cookie — SPA obtains it via /api/auth/refresh
    // after refreshToken + token_provider cookies are present.
    await applySessionCookies(ses.cookies, {
      cookieUrl: serverHost,
      refreshToken: tokens.refreshToken,
    });

    store.set('serverHost', serverHost);

    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow(serverHost);
    } else {
      await mainWindow.loadURL(serverHost);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } catch (err) {
    console.error('Failed to complete desktop auth handoff:', err);
    dialog.showErrorBox(
      'Sign-in failed',
      'Could not complete Google sign-in for Alaya Chat. Please try again.',
    );
  } finally {
    authDeepLinkInFlight = false;
  }
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 600,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      partition: PARTITION,
    },
    icon: path.join(__dirname, "build", "assets", "icon.icns"),
    resizable: false,
  });

  const loginPath = path.join(__dirname, "login.html");
  console.log("Loading login page from:", loginPath);
  loginWindow.loadFile(loginPath);
}

function createMainWindow(serverHost) {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, "build", "assets", "icon.icns"),
  });

  const url = normalizeServerHost(serverHost);

  console.log("Loading URL:", url);
  mainWindow.loadURL(url);
  attachOAuthExternalHandlers(mainWindow);

  app.setName("LibreChat UI");

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }

  // Call function to build menu
  buildMenu(url);
}

function initialize() {
  let savedHost = store.get("serverHost");
  console.log("Saved host:", savedHost);
  if (!savedHost) {
    store.set("serverHost", DEFAULT_HOST);
    savedHost = DEFAULT_HOST;
  }
  createMainWindow(savedHost);
}

// Single-instance lock so win/linux deep links arrive on second-instance.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = findDeepLinkInArgv(argv);
    if (deepLink) {
      handleAuthDeepLink(deepLink);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS deep link (also fires for cold start after ready in some Electron versions)
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) {
      handleAuthDeepLink(url);
    } else {
      app.whenReady().then(() => handleAuthDeepLink(url));
    }
  });

  // Capture cold-start deep link from argv (Windows/Linux packaged).
  const coldStartDeepLink = findDeepLinkInArgv(process.argv);

  app.whenReady().then(async () => {
    console.log("App is ready");
    registerProtocolClient();

    if (!isDev) {
      const currentPlatform = process.platform;
      if (opClient)
        opClient.track("app_started", {
          os: platformMap[currentPlatform] || currentPlatform,
          arch: process.arch,
          is_packaged: app.isPackaged,
        });
    }

    initialize();

    if (coldStartDeepLink) {
      await handleAuthDeepLink(coldStartDeepLink);
    }

    const { default: initializeShortcuts } = await import('./shortcuts.cjs');
    initializeShortcuts(globalShortcut, mainWindow);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initialize();
  }
});

ipcMain.on("submit-server-host", (event, serverHost) => {
  console.log("Saving server host:", serverHost);

  // Check if the server host starts with 'http://'
  if (serverHost.startsWith("http://")) {
    // Show a warning dialog
    dialog
      .showMessageBox({
        type: "warning",
        title: "Security Warning",
        message:
          "You are using an HTTP connection, which is insecure. Data transmitted over HTTP is not encrypted and can be intercepted by third parties. It is highly recommended to use HTTPS for a secure connection.",
        buttons: ["Continue", "Cancel"],
      })
      .then((result) => {
        if (result.response === 0) {
          // User chose to continue
          store.set("serverHost", serverHost);
          createMainWindow(serverHost);
        } else {
          // User chose to cancel - do nothing or clear the input
          console.log("User cancelled due to security warning.");
          // Optionally, send an event back to the login window to clear the input field.
          event.sender.send("clear-server-host-input");
        }
      });
  } else {
    // If it's HTTPS or another protocol, proceed without warning
    store.set("serverHost", normalizeServerHost(serverHost));
    createMainWindow(serverHost);
  }
});

ipcMain.on("reset-server", () => {
  console.log("Resetting server configuration");
  store.delete("serverHost");
  if (mainWindow) {
    mainWindow.close();
  }
  createLoginWindow();
});

// Error handling
process.on("uncaughtException", (error) => {
  console.error("An uncaught error occurred:", error);
});

app.on("render-process-gone", (event, webContents, details) => {
  console.error("Render process gone:", details);
});

app.on("child-process-gone", (event, details) => {
  console.error("Child process gone:", details);
});

function buildMenu(serverHost) { // Take serverHost as argument
  const template = [
    // { role: 'appMenu' }
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // { role: 'fileMenu' }
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Custom "Server" menu
    {
      label: 'LibreChat UI',
      submenu: [
        {
          label: 'Disconnect from host',
          click: async () => {
            const result = await dialog.showMessageBox({
              type: 'question',
              buttons: ['Disconnect', 'Cancel'],
              defaultId: 1,
              title: 'Disconnect Confirmation',
              message: `Are you sure you want to disconnect from the server?\n\n${serverHost}`, // Include serverHost in the message
            });

            if (result.response === 0) {
              console.log("Resetting server configuration from menu");
              store.delete("serverHost");
              if (mainWindow) {
                mainWindow.close();
              }
              createLoginWindow();
            }
          }
        }
      ]
    },
    // { role: 'editMenu' }
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    // { role: 'viewMenu' }
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // { role: 'windowMenu' }
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            const { shell: helpShell } = await import('electron');
            await helpShell.openExternal('https://github.com/leikoilja/librechat-ui')
          }
        },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: `
                Cmd/Ctrl+N: Start a new chat
                Cmd/Ctrl+Shift+S: Toggle sidebar
                Cmd/Ctrl+Shift+P: Toggle private chat

                Ctrl+K: Scroll up
                Ctrl+J: Scroll down
                Ctrl+U: Scroll to top
                Ctrl+D: Scroll to bottom
              `,
            });
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

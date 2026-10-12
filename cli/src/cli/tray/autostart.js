const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const APP_NAME = "ezrouter";
const APP_LABEL = "com.ezrouter.autostart";

/** Same data directory the CLI's api/client.js uses. */
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

/**
 * Marks whether autostart was enabled or explicitly disabled.
 *
 * Without it, switching to tray mode re-enabled autostart on every launch, so
 * neither way of turning it off survived: the tray's "Disable" was undone by
 * the next hide, and deleting the startup entry by hand was undone too (#3628).
 * We store "enabled" or "disabled" in this file.
 */
function autostartDecidedFile() {
  return path.join(getDataDir(), "autostart-decided");
}

function getAutoStartDecision() {
  try {
    const file = autostartDecidedFile();
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    return "decided";
  }
}

function hasDecidedAutoStart() {
  return getAutoStartDecision() !== null;
}

function rememberAutoStartDecision(state = "enabled") {
  try {
    const file = autostartDecidedFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, state);
  } catch (err) {
    // Best-effort: a data dir we cannot write is not a reason to fail the
    // enable/disable the user actually asked for.
  }
}

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument — cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js — true when 9router is currently
 *      running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists — callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === "cli.js" && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (fs.existsSync(computed)) return computed;
  return null;
}

/**
 * Enable auto startup on OS boot
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @returns {boolean} success
 */
function enableAutoStart(cliPath) {
  const platform = process.platform;

  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;

  try {
    let ok = false;
    if (platform === "darwin") ok = enableMacOS(cliPath);
    if (platform === "win32") ok = enableWindows(cliPath);
    if (platform === "linux") ok = enableLinux(cliPath);
    if (ok) rememberAutoStartDecision("enabled");
    return ok;
  } catch (err) {
    // Silent fail — autostart is optional
  }
  return false;
}

/**
 * Enable autostart on hide/tray startup if not already enabled, unless the
 * user explicitly disabled it.
 *
 * @returns {boolean} whether an entry was written on this call
 */
function ensureAutoStart(cliPath) {
  if (isAutoStartEnabled()) return false;
  if (getAutoStartDecision() === "disabled") return false;
  return enableAutoStart(cliPath);
}

/**
 * Disable auto startup
 * @returns {boolean} success
 */
function disableAutoStart() {
  const platform = process.platform;
  // Record explicit disable choice first
  rememberAutoStartDecision("disabled");
  try {
    if (platform === "darwin") return disableMacOS();
    if (platform === "win32") return disableWindows();
    if (platform === "linux") return disableLinux();
  } catch (err) {}
  return false;
}

/**
 * Check if autostart is enabled.
 *
 * On macOS, both the plist file and the launchd registration must be present —
 * otherwise the tray menu would lie about the state (showing "✓ Enabled" even
 * when launchd has the agent in a failed state or hasn't loaded it).
 */
function isAutoStartEnabled() {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
      return fs.existsSync(plistPath);
    } else if (platform === "win32") {
      const startupPath = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
      return fs.existsSync(startupPath);
    } else if (platform === "linux") {
      const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
      return fs.existsSync(desktopPath);
    }
  } catch (e) {}
  return false;
}

// ============ macOS ============

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under our agent label.
 *
 * `launchctl unload <plist>` (and `load`) for an Aqua user-domain agent sends
 * SIGTERM to the running process. When the running 9router cli.js was itself
 * spawned by the autostart launchd agent (i.e. user enabled autostart at
 * some point, then rebooted, then clicked the tray icon's "Disable
 * Auto-start" menu item), an unload would kill the very process executing
 * the click handler — and the tray icon would disappear instead of the menu
 * label flipping back to "Enable Auto-start". This helper lets the enable
 * and disable paths sidestep that by skipping launchctl when we'd otherwise
 * be killing ourselves.
 */
function isAgentSelfMacOS() {
  try {
    const output = execSync(`launchctl list ${APP_LABEL}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) {
    return false;
  }
}

function enableMacOS(cliPath) {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`);

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Clean up legacy 9router LaunchAgent if present
  const legacyPlist = path.join(launchAgentsDir, "com.9router.autostart.plist");
  if (fs.existsSync(legacyPlist)) {
    try { execSync(`launchctl unload "${legacyPlist}"`, { stdio: "ignore" }); } catch (e) {}
    try { fs.unlinkSync(legacyPlist); } catch (e) {}
  }

  let nodePath = process.execPath;
  if (process.platform === "darwin") {
    // Prefer stable symlink over Cellar versioned path to survive brew upgrade
    if (nodePath.includes("/Cellar/node") && fs.existsSync("/opt/homebrew/bin/node")) {
      nodePath = "/opt/homebrew/bin/node";
    } else if (nodePath.includes("/Cellar/node") && fs.existsSync("/usr/local/bin/node")) {
      nodePath = "/usr/local/bin/node";
    }
  }

  const routerScript = getCliJsPath(cliPath);
  // Don't write a broken plist that references a non-existent script.
  if (!routerScript) return false;

  // Include node bin dir and homebrew/usr paths in launch PATH
  const launchPath = `${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${routerScript}</string>
        <string>--tray</string>
        <string>--skip-update</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/ezrouter.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ezrouter.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plistContent);
  return true;
}

function disableMacOS() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
  const legacyPlist = path.join(os.homedir(), "Library", "LaunchAgents", "com.9router.autostart.plist");

  // Don't kill ourselves: when the current process is the running agent,
  // `launchctl unload` would send SIGTERM and the user clicking
  // "Disable Auto-start" from the tray menu would lose their tray icon
  // instead of just flipping the menu label. Skip the unload — removing the
  // plist file is enough to prevent the agent from starting on next login.
  if (!isAgentSelfMacOS()) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch (e) {}
    if (fs.existsSync(legacyPlist)) {
      try {
        execSync(`launchctl unload "${legacyPlist}"`, { stdio: "ignore" });
      } catch (e) {}
    }
  }

  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  if (fs.existsSync(legacyPlist)) {
    try { fs.unlinkSync(legacyPlist); } catch (e) {}
  }
  return true;
}

// ============ Windows ============

function enableWindows(cliPath) {
  const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const vbsPath = path.join(startupDir, `${APP_NAME}.vbs`);

  if (!fs.existsSync(startupDir)) return false;

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  // Run node + cli.js directly, hidden window. Avoids the fragile
  // `ezrouter.cmd` lookup that depended on the npm prefix path.
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${routerScript}"" --tray --skip-update", 0, False
`;
  fs.writeFileSync(vbsPath, vbsContent);
  return true;
}

function disableWindows() {
  const vbsPath = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
  }
  return true;
}

// ============ Linux ============

function enableLinux(cliPath) {
  const autostartDir = path.join(os.homedir(), ".config", "autostart");
  const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`);

  if (!fs.existsSync(autostartDir)) {
    try { fs.mkdirSync(autostartDir, { recursive: true }); }
    catch (e) { return false; }
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  const desktopContent = `[Desktop Entry]
Type=Application
Name=EzRouter
Comment=EzRouter API Proxy
Exec=${nodePath} ${routerScript} --tray --skip-update
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktopContent);
  return true;
}

function disableLinux() {
  const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
  if (fs.existsSync(desktopPath)) {
    fs.unlinkSync(desktopPath);
  }
  return true;
}

module.exports = {
  enableAutoStart,
  ensureAutoStart,
  disableAutoStart,
  isAutoStartEnabled
};

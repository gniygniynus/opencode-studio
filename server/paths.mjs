/**
 * Cross-platform path & data directory manager for OpenCode Studio.
 * Works identically on Windows, macOS, and Linux/WSL2 with zero hardcoded user paths.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

let _cachedDataRoot = "";
let _cachedPaths = null;

export function resolveDataRoot() {
  if (process.env.OPENCODE_DATA_DIR) {
    return path.resolve(process.env.OPENCODE_DATA_DIR);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "OpenCodeStudio");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "OpenCodeStudio");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, "opencode-studio");
}

export function getPaths() {
  const dataRoot = resolveDataRoot();
  if (_cachedPaths && _cachedDataRoot === dataRoot && fs.existsSync(dataRoot)) {
    return _cachedPaths;
  }

  const paths = Object.freeze({
    projectRoot: PROJECT_ROOT,
    publicDir: PUBLIC_DIR,
    dataRoot,
    dbFile: path.join(dataRoot, "studio.sqlite"),
    secretFile: path.join(dataRoot, ".local_key"),
    logsDir: path.join(dataRoot, "logs"),
    turnsLogDir: path.join(dataRoot, "logs", "turns"),
    jsonlLog: path.join(dataRoot, "logs", "server.jsonl"),
    textLog: path.join(dataRoot, "logs", "latest.log"),
    uploadsDir: path.join(dataRoot, "uploads"),
    backgroundsDir: path.join(dataRoot, "backgrounds"),
    skillsDir: path.join(dataRoot, "skills"),
    mcpDir: path.join(dataRoot, "mcp"),
    claudeConfigDir: path.join(dataRoot, "claude-config"),
    claudeRuntimeDir: path.join(dataRoot, "claude-runtime"),
    defaultCwd: os.homedir(),
  });

  for (const dir of [
    paths.dataRoot,
    paths.logsDir,
    paths.turnsLogDir,
    paths.uploadsDir,
    paths.backgroundsDir,
    paths.skillsDir,
    paths.mcpDir,
    paths.claudeConfigDir,
    paths.claudeRuntimeDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _cachedDataRoot = dataRoot;
  _cachedPaths = paths;
  return paths;
}

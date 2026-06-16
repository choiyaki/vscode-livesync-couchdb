import * as vscode from "vscode";
import { LiveSyncConfig } from "./types";

const SECTION = "livesync";

function normalizeExclude(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * 同期フォルダを正規化する（couchNotes の SyncScope.normalize と対応）。
 * 前後の空白と先頭・末尾の "/" を除去し、空・重複（大小無視）を除く。大小は path 照合のため保持。
 */
function normalizeFolders(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(",")) {
    const folder = raw.trim().replace(/^\/+|\/+$/g, "");
    if (folder.length === 0) {
      continue;
    }
    const key = folder.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(folder);
  }
  return result;
}

export function getConfig(): LiveSyncConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    url: config.get<string>("couchdb.url", "").trim(),
    database: config.get<string>("couchdb.database", "").trim(),
    username: config.get<string>("couchdb.username", "").trim(),
    syncOnSave: config.get<boolean>("syncOnSave", true),
    syncOnStartup: config.get<boolean>("syncOnStartup", false),
    autoSyncIntervalSeconds: config.get<number>("autoSyncIntervalSeconds", 0),
    liveSync: config.get<boolean>("liveSync", false),
    include: config.get<string>("include", "**/*.md"),

    exclude: normalizeExclude(config.get<string>("exclude", "**/.git/**,**/node_modules/**,**/.obsidian/**,**/.vscode/**,**/.DS_Store")),
    syncedFolders: normalizeFolders(config.get<string>("syncedFolders", ""))
  };
}

export function isConfigured(config: LiveSyncConfig): boolean {
  return Boolean(config.url && config.database && config.username);
}

export async function setConfigValue<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
}

export async function ensureConfigured(config: LiveSyncConfig): Promise<boolean> {
  return isConfigured(config);
}
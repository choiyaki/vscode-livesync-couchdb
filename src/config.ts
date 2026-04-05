import * as vscode from "vscode";
import { LiveSyncConfig } from "./types";

const SECTION = "livesync";

function normalizeExclude(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
    include: config.get<string>("include", "**/*.{md,txt,markdown}"),
    exclude: normalizeExclude(config.get<string>("exclude", "**/.git/**,**/node_modules/**,**/.obsidian/**,**/.vscode/**,**/.DS_Store"))
  };
}

export async function setConfigValue<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
}

export async function ensureConfigured(config: LiveSyncConfig): Promise<boolean> {
  if (config.url && config.database && config.username) {
    return true;
  }

  vscode.window.showWarningMessage("LiveSync CouchDB is not configured. Run 'LiveSync: Configure CouchDB'.");
  return false;
}
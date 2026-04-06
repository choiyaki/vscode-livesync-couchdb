import * as vscode from "vscode";

const SECRET_KEY_PREFIX = "livesync.couchdb.password";
const PASSPHRASE_KEY_PREFIX = "livesync.couchdb.passphrase";

function workspaceSecretKey(prefix: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return `${prefix}:${folder?.uri.toString() ?? "global"}`;
}

export async function getPassword(context: vscode.ExtensionContext): Promise<string> {
  return (await context.secrets.get(workspaceSecretKey(SECRET_KEY_PREFIX))) ?? "";
}

export async function setPassword(context: vscode.ExtensionContext, value: string): Promise<void> {
  await context.secrets.store(workspaceSecretKey(SECRET_KEY_PREFIX), value);
}

export async function getPassphrase(context: vscode.ExtensionContext): Promise<string> {
  return (await context.secrets.get(workspaceSecretKey(PASSPHRASE_KEY_PREFIX))) ?? "";
}

export async function setPassphrase(context: vscode.ExtensionContext, value: string): Promise<void> {
  await context.secrets.store(workspaceSecretKey(PASSPHRASE_KEY_PREFIX), value);
}
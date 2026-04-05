import * as vscode from "vscode";

const SECRET_KEY_PREFIX = "livesync.couchdb.password";

function workspaceSecretKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return `${SECRET_KEY_PREFIX}:${folder?.uri.toString() ?? "global"}`;
}

export async function getPassword(context: vscode.ExtensionContext): Promise<string> {
  return (await context.secrets.get(workspaceSecretKey())) ?? "";
}

export async function setPassword(context: vscode.ExtensionContext, value: string): Promise<void> {
  await context.secrets.store(workspaceSecretKey(), value);
}
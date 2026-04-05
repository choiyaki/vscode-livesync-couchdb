import * as vscode from "vscode";

export class LiveSyncStatusBar {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.item.command = "livesync.syncNow";
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.item.text = "$(sync) LiveSync";
    this.item.tooltip = "LiveSync CouchDB: idle";
  }

  setBusy(label: string): void {
    this.item.text = `$(sync~spin) LiveSync ${label}`;
    this.item.tooltip = `LiveSync CouchDB: ${label}`;
  }

  setError(message: string): void {
    this.item.text = "$(warning) LiveSync";
    this.item.tooltip = `LiveSync CouchDB error: ${message}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
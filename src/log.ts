import * as vscode from "vscode";

export class LiveSyncLogger {
  private readonly output = vscode.window.createOutputChannel("LiveSync CouchDB");

  info(message: string): void {
    this.output.appendLine(`[info] ${message}`);
  }

  warn(message: string): void {
    this.output.appendLine(`[warn] ${message}`);
  }

  error(message: string, error?: unknown): void {
    this.output.appendLine(`[error] ${message}`);
    if (error instanceof Error) {
      this.output.appendLine(error.stack ?? error.message);
    } else if (error) {
      this.output.appendLine(String(error));
    }
  }

  show(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.output.dispose();
  }
}
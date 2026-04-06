import * as vscode from "vscode";

function appendErrorDetails(output: vscode.OutputChannel, error: Error, prefix = ""): void {
  output.appendLine(prefix + (error.stack ?? error.message));
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    appendErrorDetails(output, cause, `${prefix}caused by: `);
  } else if (cause) {
    output.appendLine(`${prefix}caused by: ${String(cause)}`);
  }
}

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
      appendErrorDetails(this.output, error);
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
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { LiveSyncConfig, WorkspaceFile } from "./types";

function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function joinExcludePatterns(patterns: string[]): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  return `{${patterns.join(",")}}`;
}

function hasHiddenPathSegment(filePath: string): boolean {
  return filePath
    .split("/")
    .some((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment.startsWith("."));
}

export async function listWorkspaceFiles(config: LiveSyncConfig): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles(config.include, joinExcludePatterns(config.exclude));
  return files.filter((uri) => !hasHiddenPathSegment(relativePath(uri)));
}

export async function readWorkspaceFile(uri: vscode.Uri): Promise<WorkspaceFile> {
  const stat = await vscode.workspace.fs.stat(uri);
  const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  return {
    uri,
    relativePath: relativePath(uri),
    content,
    mtime: stat.mtime,
    contentHash: hashContent(content)
  };
}

export function getRelativePath(uri: vscode.Uri): string {
  return relativePath(uri);
}

export function hashText(content: string): string {
  return hashContent(content);
}

function splitBraceParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

function findClosingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") {
      depth += 1;
    } else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function matchGlob(pattern: string, filePath: string): boolean {
  let i = 0;
  let regex = "";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") {
        i++;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = findClosingBrace(pattern, i);
      if (close === -1) {
        regex += "\\{";
        i++;
        continue;
      }

      const inside = pattern.slice(i + 1, close);
      const parts = splitBraceParts(inside)
        .map((part) => {
          let partRegex = "";
          for (const c of part) {
            if (".+^$()|[]\\".includes(c)) {
              partRegex += `\\${c}`;
            } else if (c === "*") {
              partRegex += "[^/]*";
            } else if (c === "?") {
              partRegex += "[^/]";
            } else {
              partRegex += c;
            }
          }
          return partRegex;
        })
        .join("|");
      regex += `(?:${parts})`;
      i = close + 1;
    } else if (".+^$()|\\".includes(ch)) {
      regex += `\\${ch}`;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp(`^${regex}$`).test(filePath);
}

export function matchesFileConfig(filePath: string, config: LiveSyncConfig): boolean {
  if (hasHiddenPathSegment(filePath)) {
    return false;
  }
  if (!matchGlob(config.include, filePath)) {
    return false;
  }
  for (const pattern of config.exclude) {
    if (matchGlob(pattern, filePath)) {
      return false;
    }
  }
  return true;
}
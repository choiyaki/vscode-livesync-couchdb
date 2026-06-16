import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { LiveSyncConfig, WorkspaceFile } from "./types";

function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/**
 * 衝突判定・差分比較のためにテキストを正規化する（比較専用。保存内容は変えない）。
 *
 * ローカルファイルの生バイトと、CouchDB から再構成した本文は「中身は同じでも
 * バイト列が違う」ことがある（末尾改行の有無・CRLF/LF・BOM）。これらを比較前に
 * 揃えることで、内容が同じファイルを「変更された」と誤判定する phantom conflict を防ぐ。
 *
 * 注意: 行末スペース（Markdown のハードブレイク = 半角スペース2個）は意味を持つため
 * トリムしない。あくまで EOF 改行・改行コード・BOM のみを正規化する。
 */
export function canonicalizeContent(content: string): string {
  let s = content;
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1); // 先頭 BOM を除去
  }
  s = s.replace(/\r\n?/g, "\n"); // CRLF / 単独 CR を LF に統一
  s = s.replace(/\n+$/g, "");     // 末尾の改行（有無・個数の差）を無視
  return s;
}

/** frontmatter 内で「メタデータ扱い」として比較から除外する volatile なキー。 */
const VOLATILE_FRONTMATTER_KEY = /^(created|updated)\s*:/;

/**
 * 衝突判定のために frontmatter の created:/updated: 行を比較から除外する（比較専用）。
 *
 * couchNotes は保存のたびに `updated: <now>` を frontmatter に書き直すため、本文が
 * 同じでも内容バイトが変わる。これを「本文変更」と誤判定すると phantom conflict や
 * 不要な push churn が起きる。先頭 frontmatter（`---` 〜 `---`）内の created/updated
 * と空行を取り除いてから比較することで、時刻だけの差を無視する。
 *
 * - 先頭が `---` で閉じ `---` がある場合のみ frontmatter とみなす。
 * - frontmatter に時刻と空行しか残らなければ、frontmatter 無しと同一視する
 *   （couchNotes が plain ノートに created/updated を後付けしたケースを吸収）。
 * - 保存内容は変えない。あくまで比較用ハッシュの入力を整えるだけ。
 *
 * 前提: 入力は canonicalizeContent 済み（改行は LF）。
 */
export function stripVolatileFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") {
    return content;
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return content; // 閉じフェンスが無い＝frontmatter ではない
  }

  const inner: string[] = [];
  for (let i = 1; i < close; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      continue; // 空行は無視（couchNotes の compose と揃える）
    }
    if (VOLATILE_FRONTMATTER_KEY.test(trimmed)) {
      continue; // created:/updated: を除外
    }
    inner.push(lines[i]);
  }
  const body = lines.slice(close + 1);
  if (inner.length === 0) {
    return body.join("\n"); // 時刻だけの frontmatter は無いものとして扱う
  }
  return ["---", ...inner, "---", ...body].join("\n");
}

/**
 * 比較・衝突判定・base 記録に使う正規化ハッシュ。
 * バイトレベル正規化（canonicalizeContent）＋ frontmatter 時刻の除外
 * （stripVolatileFrontmatter）を施した内容の SHA1。
 */
export function canonicalHash(content: string): string {
  return hashContent(stripVolatileFrontmatter(canonicalizeContent(content)));
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

/**
 * このパスを同期対象とすべきか（couchNotes の SyncScope.shouldSync と対応）。
 * ルート直下（"/" を含まない）は常に true、それ以外は syncedFolders 配下なら true。
 * 照合は小文字で行う（リモート _id が小文字のため／フォルダ名の大小ゆれを吸収）。
 * syncedFolders が空ならルート直下のみ同期する（サブフォルダは対象外）。
 */
export function inSyncScope(filePath: string, config: LiveSyncConfig): boolean {
  const lower = filePath.toLowerCase();
  if (!lower.includes("/")) {
    return true;
  }
  return config.syncedFolders.some((folder) => lower.startsWith(folder.toLowerCase() + "/"));
}

export async function listWorkspaceFiles(config: LiveSyncConfig): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles(config.include, joinExcludePatterns(config.exclude));
  return files.filter((uri) => {
    const rel = relativePath(uri);
    return !hasHiddenPathSegment(rel) && inSyncScope(rel, config);
  });
}

export async function readWorkspaceFile(uri: vscode.Uri): Promise<WorkspaceFile> {
  const stat = await vscode.workspace.fs.stat(uri);
  const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  return {
    uri,
    relativePath: relativePath(uri),
    content,
    mtime: stat.mtime,
    contentHash: canonicalHash(content)
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
  if (!inSyncScope(filePath, config)) {
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
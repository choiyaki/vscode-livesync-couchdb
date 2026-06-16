import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { CouchDbChangeEntry, CouchDbChangesResult, CouchDbWriteResponse, LiveSyncConfig, RemoteDocument, ObsidianDocType } from "./types";

function buildAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function withDefaultProtocol(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function ensureValidBaseUrl(value: string): string {
  const candidate = withDefaultProtocol(value.trim());
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid CouchDB URL: ${value}`);
  }

  if (!parsed.hostname) {
    throw new Error(`Invalid CouchDB URL: ${value}`);
  }

  return trimSlash(parsed.toString());
}

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeObj = cause as { code?: string; errno?: number | string; message?: string };
    if (causeObj.code) {
      parts.push(`code=${causeObj.code}`);
    }
    if (causeObj.errno !== undefined) {
      parts.push(`errno=${causeObj.errno}`);
    }
    if (causeObj.message) {
      parts.push(`cause=${causeObj.message}`);
    }
  }

  return parts.join(", ");
}

function createLeafId(content: string): string {
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return `h:${hash}`;
}

function isLikelyLeafId(id: string): boolean {
  return /^h:[0-9a-z]{8,}$/i.test(id);
}

/**
 * 同期スコープを表す Mango selector を組み立てる（couchNotes の scopeSelector と対応）。
 * type は plain / newnote の両方を対象にする。`_id` 範囲で絞れる場合は
 * ルート（`^[^/]+$`）＋各フォルダ前方一致の `$or` を付与する。
 * folders が空ならルート直下のみ（サブフォルダは対象外）。
 *
 * canScopeById が false（Path Obfuscation 有効で `_id` がパスを表さない）の場合は
 * `_id` 範囲指定ができないため type のみで取得し、絞り込みはクライアント側に委ねる。
 */
function buildScopeSelector(scope: { folders: string[]; canScopeById: boolean }): Record<string, unknown> {
  const selector: Record<string, unknown> = { type: { $in: ["plain", "newnote"] } };
  if (!scope.canScopeById) {
    return selector;
  }
  const ors: Array<Record<string, unknown>> = [{ _id: { $regex: "^[^/]+$" } }];
  for (const folder of scope.folders) {
    const lf = folder.toLowerCase();
    // "0" は "/" (0x2F) の次の文字 (0x30)。lf/ 〜 lf0 の半開区間で lf 配下を網羅する。
    ors.push({ _id: { $gte: `${lf}/`, $lt: `${lf}0` } });
  }
  selector["$or"] = ors;
  return selector;
}

export class CouchDbClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: LiveSyncConfig,
    private readonly password: string
  ) {
    this.baseUrl = ensureValidBaseUrl(config.url);
  }

  private get databaseUrl(): string {
    return `${this.baseUrl}/${encodeURIComponent(this.config.database)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.databaseUrl}${path}`;
    const method = init?.method ?? "GET";
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: buildAuthHeader(this.config.username, this.password),
          ...(init?.headers ?? {})
        }
      });
    } catch (error) {
      const details = describeFetchFailure(error);
      throw new Error(`CouchDB request failed (${method} ${url}): ${details}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`CouchDB request failed (${method} ${url}): ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async testConnection(): Promise<void> {
    await this.request<{ db_name: string }>("");
  }

  async getDocument(path: string): Promise<RemoteDocument | undefined> {
    try {
      const doc = await this.request<RemoteDocument>(`/${encodeURIComponent(path)}`);
      if (doc && !doc.path) doc.path = doc._id;
      return doc;
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 同期スコープ内のドキュメントを Mango `_find` で取得する。
   *
   * couchNotes の scopeSelector と同じ範囲指定:
   *   - ルート直下: `_id` が "/" を含まない（`^[^/]+$`）
   *   - 各フォルダ: `_id` の前方一致を範囲クエリ `$gte:"f/"` / `$lt:"f0"` で表現（"0" は "/" の次の文字）
   * `_id` は小文字なので folders も小文字化して照合する。
   *
   * scope.canScopeById が false（passphrase による Path Obfuscation 有効＝`_id` がパスを表さない）
   * または folders が空（全フォルダ同期）の場合は `_id` 範囲指定を付けず、type のみで取得する。
   * type は Obsidian LiveSync 互換のため plain / newnote の両方を対象にする（couchNotes は plain のみ生成）。
   */
  async listDocumentsInScope(scope: { folders: string[]; canScopeById: boolean }): Promise<RemoteDocument[]> {
    const selector = buildScopeSelector(scope);
    const pageLimit = 1000;
    const docs: RemoteDocument[] = [];
    let bookmark: string | undefined;

    for (;;) {
      const body: Record<string, unknown> = { selector, limit: pageLimit };
      if (bookmark) {
        body["bookmark"] = bookmark;
      }
      const result = await this.request<{ docs: RemoteDocument[]; bookmark?: string }>("/_find", {
        method: "POST",
        body: JSON.stringify(body)
      });
      for (const doc of result.docs) {
        docs.push(...this.normalizeRemoteDocument(doc));
      }
      // 返却件数がページ上限未満なら最終ページ。bookmark が無ければ打ち切り。
      if (result.docs.length < pageLimit || !result.bookmark) {
        break;
      }
      bookmark = result.bookmark;
    }

    return docs;
  }

  async getDocumentsByIds(ids: string[]): Promise<RemoteDocument[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await this.request<{ rows: Array<{ id: string; doc?: RemoteDocument }> }>(
      "/_all_docs?include_docs=true",
      {
        method: "POST",
        body: JSON.stringify({ keys: ids })
      }
    );

    return result.rows.flatMap((row) => this.normalizeRemoteDocument(row.doc));
  }

  async listChanges(since: string | number): Promise<CouchDbChangesResult> {
    const encodedSince = encodeURIComponent(String(since));
    const result = await this.request<{
      last_seq: string;
      results: Array<{ id: string; deleted?: boolean; changes?: Array<{ rev: string }> }>;
    }>(`/_changes?since=${encodedSince}`);

    const changes = result.results.flatMap((row) => {
      if (row.id.startsWith("_")) {
        return [];
      }

      if (!row.deleted && isLikelyLeafId(row.id)) {
        return [];
      }

      return [{
        id: row.id,
        deleted: row.deleted ?? false,
        rev: row.changes?.[0]?.rev,
      } satisfies CouchDbChangeEntry];
    });

    return {
      lastSeq: result.last_seq,
      changes,
    };
  }

  async getLatestSequence(): Promise<string> {
    const result = await this.request<{ last_seq: string }>("/_changes?limit=0");
    return result.last_seq;
  }

  /**
   * CouchDB の long-polling changes feed を使い、変更が来るまで待機する。
   * タイムアウト内に変更がなければ空の results で返る。
   * AbortSignal で呼び出し元からキャンセル可能。
   */
  async pollChanges(since: string | number, timeoutMs: number, signal?: AbortSignal): Promise<CouchDbChangesResult> {
    const encodedSince = encodeURIComponent(String(since));
    const heartbeatMs = Math.max(Math.floor(timeoutMs * 0.8), 5000);
    const result = await this.request<{
      last_seq: string;
      results: Array<{ id: string; deleted?: boolean; changes?: Array<{ rev: string }> }>;
    }>(`/_changes?feed=longpoll&since=${encodedSince}&timeout=${timeoutMs}&heartbeat=${heartbeatMs}`, { signal });

    const changes = result.results.flatMap((row) => {
      if (row.id.startsWith("_")) return [];
      if (!row.deleted && isLikelyLeafId(row.id)) return [];
      return [{
        id: row.id,
        deleted: row.deleted ?? false,
        rev: row.changes?.[0]?.rev,
      } satisfies CouchDbChangeEntry];
    });

    return { lastSeq: result.last_seq, changes };
  }

  async upsertDocument(document: RemoteDocument, expectedRev?: string): Promise<CouchDbWriteResponse> {
    let rev = document._rev ?? expectedRev;
    if (!rev) {
      const existing = await this.getDocument(document._id);
      rev = existing?._rev;
    }

    const content = typeof document.data === "string" ? document.data
      : Array.isArray(document.data) ? document.data.join("") : "";
    const mtime = document.mtime;
    const isDeleted = document.deleted ?? false;
    const children = !isDeleted && content.length > 0 ? [createLeafId(content)] : [];

    if (children.length > 0) {
      await this.upsertLeafDocument(children[0], content);
    }

    const body: Record<string, unknown> = {
      _id: document._id,
      type: "plain" as ObsidianDocType,
      datatype: "plain" as ObsidianDocType,
      path: document.path,
      data: children.length > 0 ? [] : content,
      mtime,
      ctime: document.ctime ?? mtime,
      size: document.size ?? Buffer.byteLength(content, "utf8"),
      children,
      deleted: isDeleted,
      eden: {}
    };
    if (rev) {
      body["_rev"] = rev;
    }
    return await this.request<CouchDbWriteResponse>(`/${encodeURIComponent(document._id)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
  }

  private normalizeRemoteDocument(doc: RemoteDocument | undefined): RemoteDocument[] {
    const normalized = this.normalizeSingleDocument(doc);
    return normalized ? [normalized] : [];
  }

  private normalizeSingleDocument(doc: RemoteDocument | undefined): RemoteDocument | undefined {
    if (!doc) {
      return undefined;
    }
    if (doc._id.startsWith("_")) {
      return undefined;
    }
    if (!doc.deleted && doc.type !== "plain" && doc.type !== "newnote") {
      return undefined;
    }
    if (!doc.path) {
      doc.path = doc._id;
    }
    return doc;
  }

  private async upsertLeafDocument(id: string, content: string): Promise<void> {
    const body = {
      _id: id,
      type: "leaf" as ObsidianDocType,
      data: content,
    };

    try {
      await this.request<CouchDbWriteResponse>(`/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("409")) {
        return;
      }
      throw error;
    }
  }

  async tombstoneDocument(docId: string, originalPath: string, mtime: number): Promise<CouchDbWriteResponse | undefined> {
    const existing = await this.getDocument(docId);
    if (!existing) {
      return undefined;
    }

    return await this.upsertDocument({
      _id: existing._id,
      _rev: existing._rev,
      type: "plain",
      path: originalPath,
      data: "",
      mtime,
      ctime: existing.ctime ?? mtime,
      size: 0,
      deleted: true
    });
  }

  /**
   * ドキュメントのテキストコンテンツを組み立てる。
   * - plain 型: data フィールドをそのまま使用
   * - newnote 型 (children あり): leaf ドキュメントを一括取得して連結
   * - newnote 型 (children なし): data フィールドをそのまま使用
   */
  async assembleContent(doc: RemoteDocument): Promise<string> {
    const inlineContent = typeof doc.data === "string"
      ? doc.data
      : Array.isArray(doc.data)
        ? doc.data.join("")
        : "";

    // Obsidian LiveSync では type が plain でも data を持たず、children 側に本文を保持する
    // ドキュメントが存在する。まず inline data を優先し、空なら type に関係なく children を辿る。
    if (inlineContent.length > 0) {
      return inlineContent;
    }

    if (!doc.children || doc.children.length === 0) {
      return "";
    }

    const leafMap = await this.fetchLeafDocuments(doc.children);
    return doc.children.map((id) => leafMap.get(id) ?? "").join("");
  }

  /**
   * leaf ドキュメント群を一括取得し、id → data のマップを返す
   */
  private async fetchLeafDocuments(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const result = await this.request<{ rows: Array<{ id: string; doc?: { data?: string | string[] } }> }>(
      "/_all_docs?include_docs=true",
      {
        method: "POST",
        body: JSON.stringify({ keys: ids })
      }
    );
    const map = new Map<string, string>();
    for (const row of result.rows) {
      if (!row.doc) continue;
      const raw = row.doc.data;
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("") : "";
      map.set(row.id, text);
    }
    return map;
  }

  static isConflict(localMtime: number, remoteMtime: number): boolean {
    return remoteMtime > localMtime;
  }

  static toUri(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, relativePath) : undefined;
  }
}
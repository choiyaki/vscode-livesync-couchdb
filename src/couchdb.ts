import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { CouchDbChangeEntry, CouchDbChangesResult, CouchDbWriteResponse, LiveSyncConfig, RemoteDocument, ObsidianDocType } from "./types";

function buildAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function createLeafId(content: string): string {
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return `f:${hash}`;
}

function isLikelyLeafId(id: string): boolean {
  return /^[a-z]:[0-9a-f]{16,}$/i.test(id);
}

export class CouchDbClient {
  constructor(
    private readonly config: LiveSyncConfig,
    private readonly password: string
  ) {}

  private get databaseUrl(): string {
    return `${trimSlash(this.config.url)}/${encodeURIComponent(this.config.database)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.databaseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: buildAuthHeader(this.config.username, this.password),
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(`CouchDB request failed: ${response.status} ${response.statusText}`);
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

  async listDocuments(): Promise<RemoteDocument[]> {
    const result = await this.request<{ rows: Array<{ id: string; doc?: RemoteDocument }> }>("/_all_docs?include_docs=true");
    return result.rows.flatMap((row) => {
      return this.normalizeRemoteDocument(row.doc);
    });
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
      path: document._id,
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

  async tombstoneDocument(path: string, mtime: number): Promise<CouchDbWriteResponse | undefined> {
    const existing = await this.getDocument(path);
    if (!existing) {
      return undefined;
    }

    return await this.upsertDocument({
      _id: existing._id,
      _rev: existing._rev,
      type: "plain",
      path,
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
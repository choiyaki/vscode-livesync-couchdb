import * as vscode from "vscode";

export interface LiveSyncConfig {
  url: string;
  database: string;
  username: string;
  syncOnSave: boolean;
  syncOnStartup: boolean;
  autoSyncIntervalSeconds: number;
  include: string;
  exclude: string[];
}

export type ObsidianDocType = "plain" | "newnote" | "leaf";

/**
 * Obsidian LiveSync互換のCouchDBドキュメント形式
 * - plain: テキストコンテンツをdata文字列として直接保存
 * - newnote: チャンク分割してchildrenにleafドキュメントIDを保存
 * - leaf: チャンクデータ (_id: "h:sha256hash")
 */
export interface RemoteDocument {
  _id: string;
  _rev?: string;
  type: ObsidianDocType;
  datatype?: ObsidianDocType;
  path: string;            // _idと同じ (vault内相対パス)
  data?: string | string[]; // plain: コンテンツ文字列 / newnote: [] またはチャンク配列
  children?: string[];      // newnoteのleafドキュメントIDリスト
  mtime: number;
  ctime?: number;
  size?: number;
  deleted?: boolean;
  eden?: Record<string, unknown>;
}

export interface CouchDbWriteResponse {
  ok: boolean;
  id: string;
  rev: string;
}

export interface CouchDbChangeEntry {
  id: string;
  deleted: boolean;
  rev?: string;
}

export interface CouchDbChangesResult {
  lastSeq: string;
  changes: CouchDbChangeEntry[];
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  skipped: number;
  conflicts: string[];
}

export interface WorkspaceFile {
  uri: vscode.Uri;
  relativePath: string;
  content: string;
  mtime: number;
  contentHash: string;
}

export interface LocalReplicaDocument {
  path: string;
  documentId?: string;
  contentHash: string;
  localMtime: number;
  remoteRev?: string;
  remoteMtime: number;
  deleted: boolean;
  updatedAt: number;
}

export interface LocalReplicaCheckpoint {
  remoteChangesSince?: string;
  updatedAt: number;
}
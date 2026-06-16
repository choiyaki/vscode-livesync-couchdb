import * as vscode from "vscode";

export interface LiveSyncConfig {
  url: string;
  database: string;
  username: string;
  syncOnSave: boolean;
  syncOnStartup: boolean;
  autoSyncIntervalSeconds: number;
  liveSync: boolean;
  include: string;
  exclude: string[];
  /**
   * 同期対象フォルダの許可リスト（正規化済み: 前後の空白と "/" を除去）。
   * ルート直下（スラッシュ無し）は常に同期し、加えてここに挙げたフォルダ配下を同期する。
   * 空配列ならルート直下のみ同期（サブフォルダは対象外）。couchNotes の syncedFolders と対応。
   */
  syncedFolders: string[];
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
  /** 前回同期内容の正規化ハッシュ (canonicalHash)。phantom 判定の base。 */
  contentHash: string;
  /**
   * 前回同期した内容そのもの（生テキスト）。3-way マージ（案B）と、
   * ハッシュに頼らない確実な「ローカルが変わったか」判定に使う。任意。
   */
  baseContent?: string;
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
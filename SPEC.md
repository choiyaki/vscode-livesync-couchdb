# SPEC.md — vscode-livesync-couchdb

> **対象読者:** このドキュメントはコードを理解・修正するAI (Claude等) を主な対象として書いています。
> 実装済みの動作を正確に記述しており、設計意図の説明も含みます。

---

## 1. 概要

**LiveSync CouchDB** は、VS Code ワークスペースのファイルを Apache CouchDB と双方向同期する VS Code 拡張機能。Obsidian LiveSync プラグインが使う CouchDB のドキュメント形式と互換性を持つよう設計されており、Obsidian Vault と VS Code ワークスペースを同一の CouchDB データベースで共有できる。

### 主な機能
- ファイル保存時の自動プッシュ (Save-on-Sync)
- 起動時の自動同期 (Startup Sync)
- インターバルタイマーによる自動プル (Auto-pull)
- CouchDB `_changes` long-polling によるリアルタイム同期 (LiveSync mode)
- ファイル削除のリモートへの伝播 (Tombstone)
- コンフリクト検出・解決 UI (Diff / Accept Local / Accept Remote)
- Path Obfuscation (パスの難読化) — Obsidian LiveSync の E2EE 互換
- ファイルフィルタリング (glob include/exclude)

---

## 2. ファイル構成

```
src/
  extension.ts        — VS Code 拡張のエントリポイント。全コンポーネントを組み立て、コマンド・イベントを登録する
  types.ts            — 共有型定義 (インターフェース・型エイリアス)
  config.ts           — VS Code 設定の読み書きラッパー
  secrets.ts          — VS Code SecretStorage を使ったパスワード・パスフレーズ管理
  couchdb.ts          — CouchDB HTTP クライアント (CouchDbClient クラス)
  syncService.ts      — 同期ロジック本体 (SyncService クラス)
  localReplicaStore.ts — ローカルレプリカ状態の永続化 (LocalReplicaStore クラス)
  metadataStore.ts    — コンフリクト状態の永続化 (MetadataStore クラス)
  remoteWatcher.ts    — CouchDB long-polling によるリアルタイム監視 (RemoteWatcher クラス)
  pathObfuscation.ts  — Obsidian LiveSync 互換の Path Obfuscation
  workspaceFiles.ts   — ワークスペースファイルの列挙・読み込み・glob マッチング
  log.ts              — VS Code OutputChannel ラッパー (LiveSyncLogger)
  status.ts           — ステータスバー表示 (LiveSyncStatusBar)
```

---

## 3. 型定義 (`types.ts`)

### `LiveSyncConfig`
VS Code 設定から読み込まれる設定オブジェクト。

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `url` | `string` | `""` | CouchDB サーバーの Base URL (例: `https://example.com:6984`) |
| `database` | `string` | `""` | データベース名 |
| `username` | `string` | `""` | CouchDB ユーザー名 |
| `syncOnSave` | `boolean` | `true` | ファイル保存時に自動プッシュ |
| `syncOnStartup` | `boolean` | `false` | 拡張起動時に自動同期 |
| `autoSyncIntervalSeconds` | `number` | `0` | 自動プルのインターバル秒数 (0=無効) |
| `liveSync` | `boolean` | `false` | long-polling によるリアルタイム同期 |
| `include` | `string` | `"**/*.{md,txt,markdown}"` | 同期対象ファイルの glob |
| `exclude` | `string[]` | `.git`, `node_modules` 等 | 除外 glob パターンのリスト |

### `ObsidianDocType`
`"plain" | "newnote" | "leaf"` — Obsidian LiveSync の CouchDB ドキュメント種別。

### `RemoteDocument`
CouchDB に保存される Obsidian LiveSync 互換のドキュメント形式。

| フィールド | 型 | 説明 |
|---|---|---|
| `_id` | `string` | ドキュメント ID = パスの小文字化 (または obfuscated ID) |
| `_rev` | `string?` | CouchDB リビジョン |
| `type` | `ObsidianDocType` | ドキュメント種別 |
| `datatype` | `ObsidianDocType?` | 実際のデータ種別 (write 時は常に `"plain"`) |
| `path` | `string` | Vault 内の相対パス (`_id` と同じ値) |
| `data` | `string \| string[]?` | plain: コンテンツ文字列 / newnote(children なし): チャンク配列 |
| `children` | `string[]?` | newnote 型の場合、leaf ドキュメント ID リスト |
| `mtime` | `number` | ミリ秒 UNIX タイムスタンプ |
| `ctime` | `number?` | 作成時タイムスタンプ |
| `size` | `number?` | バイトサイズ |
| `deleted` | `boolean?` | 削除フラグ (tombstone) |
| `eden` | `Record<string, unknown>?` | Obsidian LiveSync 互換の拡張フィールド (常に `{}` で書き込む) |

### `LocalReplicaDocument`
ローカルレプリカストアに保存されるエントリ。ファイルとリモートドキュメントの紐付け・変更追跡に使う。

| フィールド | 型 | 説明 |
|---|---|---|
| `path` | `string` | ワークスペース相対パス |
| `documentId` | `string?` | CouchDB ドキュメント ID (obfuscated の場合は `"f:..."`) |
| `contentHash` | `string` | SHA-1 コンテンツハッシュ (最後に同期した内容) |
| `localMtime` | `number` | 最後に同期した際のローカルファイルの mtime |
| `remoteRev` | `string?` | 最後に同期した際の CouchDB `_rev` |
| `remoteMtime` | `number` | 最後に同期した際のリモート mtime |
| `deleted` | `boolean` | 削除済みフラグ |
| `updatedAt` | `number` | このエントリが最後に更新された時刻 |

### `LocalReplicaCheckpoint`
インクリメンタルプルの起点となるシーケンス番号を保持する。

| フィールド | 型 | 説明 |
|---|---|---|
| `remoteChangesSince` | `string?` | `/_changes?since=` に渡す CouchDB シーケンス番号 |
| `updatedAt` | `number` | 最終更新時刻 |

### `SyncResult`
同期操作の結果サマリ。

| フィールド | 説明 |
|---|---|
| `pushed` | プッシュ成功件数 |
| `pulled` | プル成功件数 |
| `skipped` | スキップ件数 (変更なし・除外等) |
| `conflicts` | コンフリクトが発生したパスのリスト |

---

## 4. モジュール詳細仕様

### 4.1 `config.ts`

#### `getConfig(): LiveSyncConfig`
VS Code 設定セクション `"livesync"` から `LiveSyncConfig` を構築して返す。
- `exclude` は `","` 区切りの文字列をパースして `string[]` に変換する。

#### `isConfigured(config): boolean`
`url`, `database`, `username` がすべて非空なら `true`。

#### `setConfigValue(key, value): Promise<void>`
VS Code の Workspace スコープで設定値を保存する。

#### `ensureConfigured(config): Promise<boolean>`
現状は `isConfigured` を呼ぶだけ。将来の拡張点として存在する。

---

### 4.2 `secrets.ts`

CouchDB パスワードと E2EE パスフレーズを VS Code `SecretStorage` に保存する。

- キーはワークスペースフォルダ URI をサフィックスとして使用し、ワークスペースごとに独立する。
  - パスワードキー: `"livesync.couchdb.password:<folderUri>"`
  - パスフレーズキー: `"livesync.couchdb.passphrase:<folderUri>"`
- ワークスペースフォルダが存在しない場合は `"global"` をサフィックスとして使用。

関数:
- `getPassword(context)`: パスワードを取得 (未設定なら `""`)
- `setPassword(context, value)`: パスワードを保存
- `getPassphrase(context)`: パスフレーズを取得 (未設定なら `""`)
- `setPassphrase(context, value)`: パスフレーズを保存

---

### 4.3 `couchdb.ts` — `CouchDbClient`

CouchDB REST API を呼び出す HTTP クライアント。

#### コンストラクタ
```typescript
constructor(config: LiveSyncConfig, password: string)
```
- URL は `ensureValidBaseUrl()` で正規化 (末尾スラッシュ除去・プロトコル補完)。

#### 認証
すべてのリクエストに HTTP Basic 認証ヘッダーを付加する。

#### 主要メソッド

| メソッド | 説明 |
|---|---|
| `testConnection()` | `GET /` でデータベースへの接続確認 |
| `getDocument(path)` | 単一ドキュメントを取得 (404 なら `undefined`) |
| `listDocuments()` | `_all_docs?include_docs=true` で全ドキュメント取得 |
| `getDocumentsByIds(ids)` | `POST _all_docs?include_docs=true` で複数ドキュメントをまとめて取得 |
| `listChanges(since)` | `_changes?since=...` で変更一覧取得 |
| `getLatestSequence()` | `_changes?limit=0` で現在の最新シーケンスを取得 |
| `pollChanges(since, timeoutMs, signal)` | `_changes?feed=longpoll` で long-polling |
| `upsertDocument(doc, expectedRev?)` | ドキュメントを作成または更新 |
| `tombstoneDocument(docId, _path, _mtime)` | CouchDB ネイティブ削除 (`PUT {_id,_rev,_deleted:true}`) で本物の墓標を作る。409 は rev 取り直して最大2回再試行。既に無ければ `undefined` |
| `liveNoteRevs()` | `_all_docs` で「生存」ドキュメントの id→rev マップを返す（墓標は既定で除外）。reconcile の土台 |
| `assembleContent(doc)` | ドキュメントのテキストコンテンツを組み立てる |

> **削除モデル (couchNotes 準拠):** 削除は **CouchDB ネイティブ削除** (`_deleted:true` の墓標) で表現する。
> Obsidian LiveSync 流のソフト削除 (`deleted:true` フィールドを残す方式) は **書き込まない**。
> couchNotes はソフト削除を削除信号として認識しないため、ネイティブ削除でなければ双方向で削除が伝わらない。
> ネイティブ削除は `_changes` に `deleted:true` として流れ、`_all_docs`/`_find` からは除外される——これが唯一の削除信号。
> 受信側では、過去に書かれた `deleted:true` のソフト削除ドキュメントも削除として解釈する（後方互換）。

#### ドキュメント書き込みの詳細 (`upsertDocument`)
1. `_rev` が不明な場合、`getDocument` で現在のリビジョンを取得する。
2. コンテンツから SHA-256 ハッシュで leaf ID (`h:<hash>`) を生成。
3. leaf ドキュメントを先に `upsertLeafDocument` で書き込む (409 Conflict は無視)。
4. 親ドキュメントの body:
   - `type`: `"plain"`, `datatype`: `"plain"`
   - `data`: `[]` (leaf がある場合) または内容文字列
   - `children`: `["h:<hash>"]` (leaf がある場合) または `[]`
   - `eden`: `{}`

#### コンテンツ組み立ての詳細 (`assembleContent`)
Obsidian LiveSync の複数形式に対応:
1. `doc.data` が非空文字列/配列 → それを直接使用
2. `doc.children` がある → leaf ドキュメントを `getDocumentsByIds` でまとめて取得し連結
3. それ以外 → 空文字列

#### フィルタリング (listChanges / pollChanges)
- `_` で始まる内部ドキュメント ID は除外
- 削除でない leaf ID (`h:` で始まる SHA-256 ハッシュ風 ID) は除外

#### 静的メソッド
- `CouchDbClient.isConflict(localMtime, remoteMtime)`: リモートのほうが新しければ `true`
- `CouchDbClient.toUri(relativePath)`: 相対パスを最初のワークスペースフォルダの絶対 URI に変換

---

### 4.4 `pathObfuscation.ts`

Obsidian LiveSync の Path Obfuscation と完全互換の実装。

#### `path2id(filePath, passphrase?, caseInsensitive=true): string`
ファイルパスを CouchDB ドキュメント ID に変換する。

**passphrase なし (通常モード):**
- パスを小文字化 (`caseInsensitive=true` の場合)
- `_` で始まる場合は先頭に `/` を付加

**passphrase あり (Path Obfuscation モード):**
- `f:` プレフィックスが付いているパスはそのまま返す
- `SHA-256(SHA-256(passphrase) + ":" + lowercase_path)` を計算
- 結果を `f:<hash>` 形式で返す
- パスにプレフィックス (`xxx:`) があればプレフィックスを保持

#### `isObfuscatedId(id): boolean`
ID が `"f:"` で始まれば `true`。Pull 時に変更 ID が obfuscated かどうかの判断に使用。

---

### 4.5 `workspaceFiles.ts`

#### `listWorkspaceFiles(config): Promise<vscode.Uri[]>`
`config.include` glob に一致し、`config.exclude` glob のいずれにも一致しないファイルを列挙。
- さらに `.gitignore` のような隠しパスセグメント (`.` で始まる) を持つファイルを除外。

#### `readWorkspaceFile(uri): Promise<WorkspaceFile>`
ファイルを UTF-8 で読み込み、`WorkspaceFile` オブジェクトを返す。
- `contentHash`: SHA-1 ハッシュ (コンテンツ変更検知に使用)
- `mtime`: `vscode.workspace.fs.stat` の mtime (ミリ秒)

#### `matchesFileConfig(filePath, config): boolean`
ファイルパスが include/exclude 条件を満たすか確認する。
- 独自の glob マッチング実装 (`matchGlob` 関数)
  - `**` → `.*` (パス区切りを越えるワイルドカード)
  - `*` → `[^/]*` (単一セグメント内ワイルドカード)
  - `{a,b,c}` → `(?:a|b|c)` (ブレース展開)

#### `hashText(content): string`
SHA-1 ハッシュを返す (内部的には `hashContent` のエイリアス)。

---

### 4.6 `localReplicaStore.ts` — `LocalReplicaStore`

ローカルレプリカの状態を永続化するストア。同期済みの各ファイルについて、最後に同期した状態 (ハッシュ・mtime・CouchDB rev) を記憶する。

#### 永続化ファイル
`{context.storageUri}/livesync-local-replica.json`

```json
{
  "version": 1,
  "documents": {
    "notes/example.md": {
      "path": "notes/example.md",
      "documentId": "notes/example.md",
      "contentHash": "abc123...",
      "localMtime": 1700000000000,
      "remoteRev": "1-xxxx",
      "remoteMtime": 1700000000000,
      "deleted": false,
      "updatedAt": 1700000001000
    }
  },
  "checkpoint": {
    "remoteChangesSince": "12345-g...",
    "updatedAt": 1700000001000
  }
}
```

#### 主要メソッド
| メソッド | 説明 |
|---|---|
| `initialize()` | ファイルから状態を読み込む (冪等) |
| `get(path)` | パスでエントリを取得 |
| `getPathByDocumentId(docId)` | ドキュメント ID からパスを逆引き (obfuscated ID 対応) |
| `upsert(document)` | エントリを追加・更新して永続化 |
| `markDeleted(path, rev, mtime)` | 削除フラグを立てて永続化 |
| `remove(path)` | エントリを削除して永続化 |
| `updateCheckpoint(partial)` | チェックポイント (インクリメンタルプルの起点) を更新 |
| `listPaths()` | 追跡中の全パスを返す |
| `getCheckpoint()` | 現在のチェックポイントを返す |

---

### 4.7 `metadataStore.ts` — `MetadataStore`

コンフリクト状態のみを永続化するストア。コンフリクト中のファイルについて、リモートの `_rev` を記憶する。

#### 永続化ファイル
`{context.storageUri}/livesync-metadata.json`

```json
{
  "version": 1,
  "entries": {
    "notes/conflicted.md": {
      "path": "notes/conflicted.md",
      "remoteRev": "3-xxxx",
      "conflicted": true,
      "updatedAt": 1700000002000
    }
  }
}
```

**注意:** 初期化時に `conflicted: true` のエントリのみを読み込む (false のエントリは無視)。

#### 主要メソッド
| メソッド | 説明 |
|---|---|
| `initialize()` | ファイルから状態を読み込む (冪等) |
| `get(relativePath)` | パスでエントリを取得 |
| `listConflicts()` | コンフリクト中のパスのリストを返す |
| `setConflict(relativePath, remoteRev?)` | コンフリクトを記録 |
| `clearConflict(relativePath)` | コンフリクトをクリア |

---

### 4.8 `remoteWatcher.ts` — `RemoteWatcher`

CouchDB `/_changes?feed=longpoll` を使ったリアルタイム監視クラス。

#### 定数
- `POLL_TIMEOUT_MS = 30,000`: long-polling タイムアウト (30秒)
- `RECONNECT_BASE_DELAY_MS = 1,000`: 再接続の初期遅延
- `RECONNECT_MAX_DELAY_MS = 60,000`: 再接続の最大遅延

#### コンストラクタ引数
| 引数 | 説明 |
|---|---|
| `makeClient` | 最新の認証情報で `CouchDbClient` を返すファクトリ。未設定時は `undefined` を返す |
| `getLastSeq` | 現在のチェックポイントシーケンスを返すゲッター |
| `onChangesDetected` | 変更検出時に呼ばれるコールバック |
| `logger` | ロガー |

#### 動作ループ
1. `makeClient()` が `undefined` を返す間は 5 秒待って再試行。
2. `pollChanges(since, 30000, signal)` を呼ぶ。
3. 変更があれば `onChangesDetected()` を呼ぶ。
4. エラー時は指数バックオフ (1s → 2s → 4s → ... → 60s) で再試行。
5. `AbortError` は正常停止として扱い、ループを終了。

#### `start()` / `stop()`
- `start()`: 監視ループを非同期で開始 (既に起動中なら無視)
- `stop()`: `AbortController.abort()` でループを停止

---

### 4.9 `syncService.ts` — `SyncService`

同期ロジックの中核クラス。

#### コンストラクタ引数
| 引数 | 型 | 説明 |
|---|---|---|
| `config` | `LiveSyncConfig` | 設定 |
| `client` | `CouchDbClient` | CouchDB クライアント |
| `logger` | `LiveSyncLogger` | ロガー |
| `metadata` | `MetadataStore` | コンフリクトメタデータ |
| `localReplica` | `LocalReplicaStore` | ローカルレプリカ状態 |
| `passphrase` | `string \| undefined` | Path Obfuscation パスフレーズ |

#### ドキュメント ID 変換
`docId(relativePath)` = `path2id(relativePath, this.passphrase)` — obfuscated ID または小文字化パス

---

#### `pushAll(): Promise<SyncResult>`
ワークスペース全ファイルをリモートに一括プッシュ。

**ステップ:**
1. **Tombstone プッシュ**: `localReplica` に記録があるが実際のファイルが存在しないパスを検出し、CouchDB 上でネイティブ削除（墓標化）する。これでローカルの物理削除がリモート（および couchNotes 等の他端末）へ伝播する。
2. **各ファイルのプッシュ判定:**
   - `localMtime` が変わっていない → `skipped`
   - `contentHash` が変わっていない → `skipped`
   - リモートにドキュメントがある場合:
     - リモートコンテンツが同一 → `localReplica` を更新して `skipped`
     - リモートの `_rev` が変わっており内容も異なる → コンフリクト記録して `skipped`
     - それ以外 (ミスマッチ) → ログを記録して上書きプッシュ
   - 上記に該当しない → `upsertDocument` でプッシュして `localReplica` 更新

---

#### `pullAll(): Promise<SyncResult>`
全ドキュメントを `listDocuments()` で取得し、`applyRemoteDocuments` で適用。
- 完了後にチェックポイントを現在の最新シーケンスに更新。
- 最後に `reconcile()` を呼び、サーバから消えたノートのローカルファイルを物理削除する。

#### `reconcile(): Promise<SyncResult>` (couchNotes 準拠の最終保証)
ネイティブ削除（墓標）は `_find`/`_all_docs` に出てこないため、差分 pull（`_changes`）を取りこぼすと
ローカルに残り続ける。これに対する収束処理。

**ステップ:**
1. `liveNoteRevs()` でサーバの**生存** id→rev を取得。**空なら異常の可能性 → 何もしない**（誤った全削除を防ぐ安全ガード）。
2. `localReplica` の追跡パスを走査し、サーバ生存集合に `documentId` が無いものを「削除済み」とみなす。
   - スコープ外（`matchesFileConfig` 不一致）/ コンフリクト中 / 既に削除済み → 触らない。
   - 未 push のローカル編集（ローカルの `contentHash` が追跡値と異なる）→ 削除せず保護（`skipped`）。次の `pushAll` でサーバへ復活。
   - クリーンなファイル → ローカル物理削除（`useTrash:false`）し、`localReplica` を削除済みに（`pulled`）。

**自動実行タイミング:** 起動同期、手動「Sync Now」、全 Pull（`pullAll`）。差分 Pull（`pullIncremental`）単独では実行しない。

---

#### `pullIncremental(): Promise<SyncResult>`
`localReplica.getCheckpoint().remoteChangesSince` から差分のみを取得。
- チェックポイントがない場合は `pullAll()` にフォールバック。
- 削除変更: obfuscated ID の逆引き → `applyRemoteDocuments` で削除処理
- 更新変更: `changedIds` を収集 → `getDocumentsByIds` でまとめて取得 → `applyRemoteDocuments`
- 完了後にチェックポイントを更新。

**スキップ条件 (pullIncremental):**
- 追跡済み `remoteRev` と変更の `rev` が一致 → `skipped`
- obfuscated ID で逆引きできない削除変更 → `skipped`
- すでに削除済みとして追跡されている削除変更 → `skipped`

---

#### `pushSingle(uri): Promise<SyncResult>`
保存トリガー時の単一ファイルプッシュ。`pushAll` のシングルファイル版ロジック。

---

#### `pushDeletion(relativePath): Promise<boolean>`
ファイル削除時に呼ばれる。`localReplica` に追跡エントリがあれば tombstone をプッシュし、エントリを削除済みとしてマーク。

---

#### `applyRemoteDocuments(docs, result): Promise<void>` (private)
リモートドキュメント群をローカルに適用する共通処理。

**各ドキュメントの処理フロー:**
1. `matchesFileConfig` でフィルタリング → 除外なら `skipped`
2. `deleted: true` → ローカルファイルを削除して `pulled`
3. リモートコンテンツが空なら警告ログ
4. ローカルファイルを読み込んでハッシュ比較:
   - 同一 → `localReplica` のみ更新して `skipped`
   - 双方向コンフリクト (ローカルとリモート両方が変更) → コンフリクト記録して `skipped`
   - それ以外 → ファイルを上書きして `pulled`

---

#### コンフリクト判定ロジック

**Push 時のコンフリクト (`hasRemoteConflict`):**
```
trackedRemoteRev != remoteRev  // リモートが自分の知らないうちに変更された
AND
localHash != remoteHash        // かつ内容も異なる
```
→ 「リモートが変更されており、それと自分のローカル内容が食い違う」

**Pull 時のコンフリクト (`hasBidirectionalConflict`):**
```
existingLocalHash != tracked.contentHash   // ローカルが最後の同期から変更された
AND
tracked.remoteRev != remoteRev             // リモートも最後の同期から変更された
AND
existingLocalHash != remoteHash            // かつ内容が異なる
```
→ 「ローカルとリモード両方が独立して変更された」

---

#### `resolveConflict(relativePath, choice): Promise<void>`
- `"local"`: ローカルファイルを `upsertDocument` でプッシュ (409 時は最新リビジョンで再試行)
- `"remote"`: リモートドキュメントをローカルファイルに上書き

---

#### `fetchRemoteForDiff(relativePath)`: Diff 表示用にリモートコンテンツを取得

---

### 4.10 `log.ts` — `LiveSyncLogger`
VS Code OutputChannel `"LiveSync CouchDB"` にログを書き込む。
- `info(message)`: `[info]` プレフィックス
- `warn(message)`: `[warn]` プレフィックス
- `error(message, error?)`: `[error]` プレフィックス、Error オブジェクトのスタックトレース・cause チェーンを再帰展開

---

### 4.11 `status.ts` — `LiveSyncStatusBar`
ステータスバー左側 (priority=100) に `$(sync) LiveSync` を表示。
- クリックで `livesync.syncNow` を実行
- 動作中: `$(sync~spin) LiveSync <label>`
- エラー: `$(warning) LiveSync`

---

### 4.12 `extension.ts` — エントリポイント

#### コンポーネント初期化 (activate 関数内)
```
LiveSyncLogger        → ログ出力
LiveSyncStatusBar     → ステータスバー
MetadataStore         → コンフリクト状態永続化
LocalReplicaStore     → レプリカ状態永続化
```

#### モジュールレベル状態変数
| 変数 | 型 | 説明 |
|---|---|---|
| `runningSync` | `Promise<void> \| undefined` | 手動同期が実行中かどうか |
| `runningAutoPull` | `Promise<void> \| undefined` | 自動プルが実行中かどうか |
| `syncQueue` | `Promise<void>` | 同期操作のシリアライズキュー |
| `latestSaveUris` | `Map<string, Uri>` | 保存トリガー時の最新 URI (バッチ処理用) |
| `scheduledSavePushes` | `Set<string>` | プッシュがスケジュール済みのパスセット |
| `pendingDeleteTimers` | `Map<string, Timer>` | 削除のデバウンスタイマー |

---

## 5. コマンド仕様

| コマンド ID | タイトル | 動作 |
|---|---|---|
| `livesync.configure` | LiveSync: Configure CouchDB | URL・DB名・ユーザー名・パスワード・パスフレーズを InputBox で入力し保存 |
| `livesync.testConnection` | LiveSync: Test CouchDB Connection | `client.testConnection()` を実行し結果をメッセージで表示 |
| `livesync.syncNow` | LiveSync: Sync Now | `pushAll` → `pullIncremental` を順に実行 (同期中なら無視) |
| `livesync.pushNow` | LiveSync: Push Now | dirty ファイルを保存してから `pushAll` |
| `livesync.pullNow` | LiveSync: Pull Now | `pullIncremental` |
| `livesync.pullFullNow` | LiveSync: Full Pull Now | `pullAll` (全件取得) |
| `livesync.showConflicts` | LiveSync: Show Conflicts | コンフリクト一覧を QuickPick で表示し、Diff/Accept Local/Accept Remote を選択可能 |
| `livesync.resolveConflict` | LiveSync: Resolve Conflict | `showConflicts` に委譲 |

### コンフリクト解決 UI の詳細
1. `metadata.listConflicts()` でコンフリクトファイルを一覧表示
2. ファイルを選択後、アクションを選択:
   - **Show Diff**: リモートコンテンツを一時ファイルに書き込み `vscode.diff` コマンドで比較表示
   - **Accept Local**: `service.resolveConflict(path, "local")`
   - **Accept Remote**: `service.resolveConflict(path, "remote")`

---

## 6. 同期フローとイベント処理

### 6.1 ファイル保存時の同期 (`syncOnSave`)

```
TextDocument.onDidSave
  → matchesFileConfig チェック
  → 接続設定が存在するか確認
  → pendingDeleteTimers のキャンセル (削除後の再作成で誤 tombstone を防ぐ)
  → scheduleSavePush(uri)
    → enqueueSyncOperation でキュー追加
    → service.pushSingle(uri)
```

**バッチ最適化:** 短時間に複数回保存された場合、`latestSaveUris` に最新 URI を記録し、
`scheduledSavePushes` で重複スケジュールを防ぐ。処理後に `latestSaveUris` に残った分を再処理。

### 6.2 ファイル削除時の同期

```
FileSystemWatcher.onDidDelete
  → matchesFileConfig チェック
  → scheduleDeletePush(uri) — 1500ms デバウンス
    → 実行時にファイルが実際に存在するか確認 (誤検知防止)
    → service.pushDeletion(relativePath)
```

**デバウンス理由:** ファイル移動 (削除+作成) を tombstone として誤送信しないため。
`onDidCreate` が来たらデバウンスタイマーをキャンセルする。

### 6.3 Sync Queue (直列化)

すべての同期操作は `enqueueSyncOperation` を通じてキューに入れられる。
前の操作が完了するまで次は実行されない (`.catch(() => undefined).then(operation)` パターン)。

### 6.4 起動時同期 (`syncOnStartup`)

`setImmediate` で遅延実行し、`pushAll` + `pullIncremental` を実行。

### 6.5 自動プルタイマー (`autoSyncIntervalSeconds`)

起動時に `setInterval` を設定。
- `runningSync` または `runningAutoPull` が実行中ならスキップ。
- `pullIncremental` を実行。

### 6.6 Live Sync (long-polling)

`liveSync: true` かつ設定済みの場合、`RemoteWatcher.start()` を呼ぶ。
変更検出時に `enqueueSyncOperation` → `service.pullIncremental()`。
設定変更時 (`onDidChangeConfiguration`) に状態を再評価。

---

## 7. CouchDB ドキュメントフォーマット互換性

この拡張機能は **Obsidian LiveSync** プラグインが使う CouchDB フォーマットと互換性を持つ。

### Write 時のフォーマット (常に plain+leaf 形式)
```json
{
  "_id": "notes/example.md",
  "type": "plain",
  "datatype": "plain",
  "path": "notes/example.md",
  "data": [],
  "children": ["h:sha256ofcontent..."],
  "mtime": 1700000000000,
  "ctime": 1700000000000,
  "size": 1234,
  "deleted": false,
  "eden": {}
}
```
leaf ドキュメント:
```json
{
  "_id": "h:sha256ofcontent...",
  "type": "leaf",
  "data": "actual file content here"
}
```

### Read 時の互換性
- `plain` 型: `data` フィールドを直接使用
- `newnote` 型 + `children`: leaf ドキュメントを取得して連結
- `newnote` 型 + children なし: `data` フィールドを使用
- `data` が空でも `children` があれば children を優先する

### フィルタリング
- `_id` が `_` で始まるドキュメント → CouchDB 内部ドキュメント、無視
- `_id` が `h:[0-9a-z]{8,}` に一致するドキュメント → leaf ドキュメント、無視
- `deleted: true` のドキュメント → tombstone として処理

---

## 8. Path Obfuscation

Obsidian LiveSync の E2EE オプション「Path Obfuscation」に対応。

### 仕組み
- パスフレーズが設定されている場合、ファイルパスを CouchDB の `_id` にマッピングする際に SHA-256 ハッシュで難読化。
- ドキュメント ID は `f:<sha256hash>` の形式になる。
- `path` フィールドには元のパスが平文で保存される。

### VS Code 側の影響
- Push 時: `path2id(filePath, passphrase)` で obfuscated ID を生成して書き込む。
- Pull 時: `_changes` の変更 ID が `f:` で始まる場合は `localReplica.getPathByDocumentId()` で元パスを逆引きする。逆引きできない場合はスキップ。

---

## 9. ストレージ

### 設定値 (VS Code workspace settings)
`{workspace}/.vscode/settings.json` に保存:
```json
{
  "livesync.couchdb.url": "https://...",
  "livesync.couchdb.database": "obsidian-vault",
  "livesync.couchdb.username": "admin",
  "livesync.syncOnSave": true,
  "livesync.syncOnStartup": false,
  "livesync.autoSyncIntervalSeconds": 0,
  "livesync.liveSync": false,
  "livesync.include": "**/*.{md,txt,markdown}",
  "livesync.exclude": "**/.git/**,**/node_modules/**,..."
}
```

### シークレット (VS Code SecretStorage)
OS のキーチェーンに暗号化して保存 (平文でファイルに書かれない)。

### 状態ファイル (context.storageUri)
VS Code の拡張機能ストレージ領域 (通常 `~/Library/Application Support/Code/User/workspaceStorage/<id>/local-dev.vscode-livesync-couchdb/`) に保存:
- `livesync-local-replica.json`: ローカルレプリカ状態
- `livesync-metadata.json`: コンフリクト状態

---

## 10. エラーハンドリング・ガード

### 設定未完了の場合
- `isConfigured` が false → ユーザーに「Configure CouchDB」ボタン付き通知 (1回のみ)
- パスワード未設定 → 同様の通知

### CouchDB 接続エラー
- `runWithClient` のラッパー内でキャッチ → OutputChannel にエラー出力 + ステータスバーにエラー表示 + エラーメッセージ通知

### Dirty ドキュメント保護
- Push/Sync 時に未保存ドキュメントを自動保存。保存失敗時はキャンセル。

### 削除の誤検知防止
- ファイル削除イベントから 1500ms のデバウンス
- 実行前にファイルの存在を確認 (`fs.stat`)
- `onDidCreate` イベントでタイマーをキャンセル

---

## 11. 起動・終了

### 起動 (`activate`)
1. `LiveSyncLogger`, `LiveSyncStatusBar`, `MetadataStore`, `LocalReplicaStore` を初期化
2. コマンドを登録
3. `FileSystemWatcher` を作成
4. `onDidSaveTextDocument`, `onDidDelete`, `onDidCreate` リスナーを登録
5. `syncOnStartup` が有効なら `setImmediate` で起動時同期をスケジュール
6. `RemoteWatcher` を作成
7. `autoSyncIntervalSeconds` > 0 なら自動プルタイマーを設定
8. `applyLiveSyncConfig()` で liveSync 状態を評価・開始

### 終了 (`deactivate`)
すべてのリソース (`Disposable`) が自動的に解放される:
- `LiveSyncLogger.dispose()` → OutputChannel を閉じる
- `LiveSyncStatusBar.dispose()` → ステータスバーアイテムを削除
- `RemoteWatcher.stop()` → long-polling ループを停止
- `FileSystemWatcher` を破棄
- デバウンスタイマーを全クリア
- 自動プルタイマーを停止 (`clearInterval`)

---

## 12. 依存関係

### Runtime
- `vscode` API (^1.98.0) — 拡張機能ホスト
- Node.js 標準モジュール: `node:crypto` (ハッシュ計算), `node:path` (パス操作)
- ブラウザ互換 `fetch` API (VS Code 拡張ホスト環境で利用可能)

### 外部ライブラリ
**なし** — 意図的に外部 npm パッケージへの依存を排除している。

### DevDependencies
- `typescript` ^5.8.2
- `@types/vscode` ^1.98.0
- `@types/node` ^22.14.1
- `@vscode/vsce` ^3.7.1

---

## 13. ビルド

```bash
npm run compile      # TypeScript コンパイル → out/
npm run watch        # ウォッチモード
npm run package:vsix # .vsix パッケージ生成 (npx @vscode/vsce package --skip-license)
```

出力: `out/extension.js` がエントリポイント。

---

## 14. 設計上の注意点・制約

1. **ワークスペース単体前提**: `vscode.workspace.workspaceFolders?.[0]` のみを使用。マルチルートワークスペースは非対応。

2. **mtime ベースの変更検知**: ローカルファイルの変更は `stat.mtime` と `contentHash` の両方で判定。mtime だけでの判定は行わない (mtime が同一でも内容が変わっている可能性への対応)。

3. **Push がリモートを上書き**: コンフリクトがない限り、`pushAll` はリモートドキュメントを問答無用で上書きする (rev を取得してから PUT する)。Obsidian LiveSync の CRDT/マージ機構は持たない。

4. **Leaf ドキュメントの孤立**: leaf ドキュメントの GC (ガベージコレクション) は行わない。古い leaf (`h:...`) はデータベースに残り続ける。

5. **UTF-8 のみ対応**: ファイル読み書きはすべて UTF-8 エンコーディング固定。バイナリファイルは同期対象外 (glob フィルタで除外される)。

6. **シングルスレッド直列化**: `syncQueue` により同期操作は直列実行される。並列同期は行わない。

7. **自動保存前提**: `syncOnSave` は `onDidSaveTextDocument` に依存する。VS Code の auto-save が無効でファイルを明示的に保存しない場合は同期されない。

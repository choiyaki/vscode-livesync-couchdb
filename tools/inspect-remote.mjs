#!/usr/bin/env node
// 実データ検証用ツール：CouchDB 上のノート本文と、ローカルファイルを行単位で比較する。
// 衝突の差分が frontmatter の created:/updated: 行だけなのか、本文も違うのかを確認する。
//
// 使い方:
//   COUCH_URL=http://localhost:5984 COUCH_DB=mydb COUCH_USER=admin COUCH_PASS=secret \
//   [COUCH_PASSPHRASE=xxx] [WORKSPACE_ROOT=/path/to/vault] \
//   node tools/inspect-remote.mjs "folder/note.md"
//
//   一覧（mtime 降順で最近更新されたノートを表示。衝突したノートを選ぶ手がかり）:
//   ... node tools/inspect-remote.mjs --list
//
// 注意: このプラグインの「E2EE」はパス難読化のみ。本文・path フィールドは平文なので比較できる。

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const URL_BASE = (process.env.COUCH_URL || "").replace(/\/$/, "");
const DB = process.env.COUCH_DB || "";
const USER = process.env.COUCH_USER || "";
const PASS = process.env.COUCH_PASS || "";
const PASSPHRASE = process.env.COUCH_PASSPHRASE || "";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();
// 前回同期内容のハッシュ(base)を持つ replica JSON。省略時は自動探索しない（パスを渡す）。
const REPLICA_JSON = process.env.REPLICA_JSON || "";

if (!URL_BASE || !DB || !USER) {
  console.error("環境変数 COUCH_URL / COUCH_DB / COUCH_USER (/ COUCH_PASS) を設定してください。");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const dbUrl = `${URL_BASE}/${encodeURIComponent(DB)}`;

async function req(p, init) {
  const res = await fetch(`${dbUrl}${p}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}`);
  return res.json();
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

// src/workspaceFiles.ts の hashContent と同じ（base/local/remote の比較に使う）
function sha1hex(s) {
  return crypto.createHash("sha1").update(Buffer.from(s, "utf8")).digest("hex");
}

// replica JSON から、対象パスの base 情報（前回同期時の contentHash 等）を読む
async function loadBase(relPath) {
  if (!REPLICA_JSON) return undefined;
  try {
    const raw = await fs.readFile(REPLICA_JSON, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.documents?.[relPath];
  } catch (e) {
    console.error(`replica JSON 読込失敗: ${e.message}`);
    return undefined;
  }
}

// src/pathObfuscation.ts の path2id と同じロジック
function path2id(filePath) {
  const lower = filePath.toLowerCase();
  if (!PASSPHRASE) {
    return lower.startsWith("_") ? "/" + lower : lower;
  }
  const hashedPass = sha256hex(PASSPHRASE);
  return "f:" + sha256hex(`${hashedPass}:${lower}`);
}

// src/couchdb.ts の assembleContent と同じロジック
async function assembleContent(doc) {
  const inline = typeof doc.data === "string" ? doc.data : Array.isArray(doc.data) ? doc.data.join("") : "";
  if (inline.length > 0) return inline;
  const children = doc.children ?? [];
  if (children.length === 0) return "";
  const result = await req("/_all_docs?include_docs=true", {
    method: "POST",
    body: JSON.stringify({ keys: children }),
  });
  const map = new Map();
  for (const row of result.rows) {
    const d = row.doc;
    if (!d) continue;
    const raw = d.data;
    map.set(row.id, typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("") : "");
  }
  return children.map((id) => map.get(id) ?? "").join("");
}

// 最小 LCS 行 diff
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(["=", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["-", a[i]]); i++; }
    else { out.push(["+", b[j]]); j++; }
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

const FM_KEY = /^\s*(created|updated)\s*:/;

async function listNotes() {
  const result = await req("/_all_docs?include_docs=true&limit=100000");
  const notes = result.rows
    .map((r) => r.doc)
    .filter((d) => d && !d._id.startsWith("_") && !d._id.startsWith("h:") && d.deleted !== true && (d.type === "plain" || d.type === "newnote" || d.children || typeof d.data === "string"))
    .map((d) => ({ path: d.path || d._id, mtime: d.mtime || 0 }))
    .sort((x, y) => y.mtime - x.mtime);
  for (const n of notes.slice(0, 50)) {
    console.log(`${new Date(n.mtime).toISOString()}  ${n.path}`);
  }
  console.log(`\n(${notes.length} notes total; showing newest 50)`);
}

async function inspect(relPath) {
  const id = path2id(relPath);
  let doc;
  try {
    doc = await req(`/${encodeURIComponent(id)}`);
  } catch (e) {
    console.error(`リモート取得失敗: ${e.message}\n  _id=${id}`);
    process.exit(1);
  }
  const remote = await assembleContent(doc);

  const localPath = path.join(WORKSPACE_ROOT, relPath);
  let local;
  try {
    local = await fs.readFile(localPath, "utf8");
  } catch {
    console.error(`ローカル読込失敗: ${localPath}\n  (WORKSPACE_ROOT が正しいか確認)`);
    process.exit(1);
  }

  const base = await loadBase(relPath);

  const localHash = sha1hex(local);
  const remoteHash = sha1hex(remote);
  const baseHash = base?.contentHash;

  console.log(`path        : ${relPath}`);
  console.log(`_id         : ${id}`);
  console.log(`remote mtime: ${doc.mtime ? new Date(doc.mtime).toISOString() : "(none)"}  rev=${doc._rev}`);
  console.log(`base  (前回同期) sha1: ${baseHash ?? "(replica JSON 未指定)"}  rev=${base?.remoteRev ?? "-"}`);
  console.log(`local (現ファイル) sha1: ${localHash}`);
  console.log(`remote(現CouchDB) sha1: ${remoteHash}`);
  console.log(`local bytes : ${Buffer.byteLength(local)}   remote bytes: ${Buffer.byteLength(remote)}`);

  // 3点比較で衝突の性質を分類
  console.log("\n===== 判定 =====");
  if (baseHash) {
    const localChanged = localHash !== baseHash;
    const remoteChanged = remoteHash !== baseHash;
    console.log(`local は base から ${localChanged ? "変化あり" : "変化なし"} / remote は base から ${remoteChanged ? "変化あり" : "変化なし"}`);
    if (!localChanged && remoteChanged) {
      console.log("🅰️ phantom: PC側は未変更。本来 remote 優先で上書きすべきで衝突にならないはず → 誤検知（案A：判定/ラウンドトリップの問題）");
    } else if (localChanged && remoteChanged) {
      console.log("🅱️ 真の双方向変更：local も remote も base から変わっている");
    } else if (localChanged && !remoteChanged) {
      console.log("ℹ️ local のみ変更（push されるべき。衝突ではない）");
    } else {
      console.log("ℹ️ 双方 base と同一（衝突ではない）");
    }
  } else {
    console.log("※ REPLICA_JSON を指定すると base と比較して phantom か真の衝突かを判定できます。");
  }

  if (local === remote) {
    console.log("\nlocal と remote は現在一致（差分なし）。");
    return;
  }

  // local↔remote の行差分（差分が frontmatter 時刻のみかも見る）
  const diff = diffLines(local.split("\n"), remote.split("\n"));
  const changed = diff.filter((d) => d[0] !== "=");
  const onlyFrontmatterTimes = changed.length > 0 && changed.every((d) => FM_KEY.test(d[1]));

  console.log("\n--- diff local↔remote (- local / + remote) ---");
  for (const [sign, line] of diff) {
    if (sign === "=") continue;
    console.log(`${sign} ${JSON.stringify(line)}`);
  }
  console.log(`\n変更行数: ${changed.length} (うち frontmatter時刻行: ${changed.filter((d) => FM_KEY.test(d[1])).length})`);
  if (onlyFrontmatterTimes) {
    console.log("→ local↔remote の差分は created:/updated: 行のみ（②frontmatter正規化が効く型）");
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('引数にノートの相対パスを渡してください。例: node tools/inspect-remote.mjs "folder/note.md"\n一覧は --list');
  process.exit(1);
}
if (arg === "--list") await listNotes();
else await inspect(arg);

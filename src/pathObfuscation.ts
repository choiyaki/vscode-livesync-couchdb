import * as crypto from "node:crypto";

const PREFIX_OBFUSCATED = "f:";

/**
 * Obsidian LiveSync の hashString 互換。
 * UTF-8 エンコードした文字列の SHA-256 hex を返す。
 */
function hashString(key: string): string {
  return crypto.createHash("sha256").update(Buffer.from(key, "utf8")).digest("hex");
}

function expandPrefix(path: string): [string, string] {
  const idx = path.indexOf(":");
  if (idx === -1) return ["", path];
  return [path.substring(0, idx + 1), path.substring(idx + 1)];
}

/**
 * ファイルパスを CouchDB ドキュメント ID に変換する。
 * caseInsensitive が true (デフォルト) の場合、Obsidian LiveSync と同様にパスを小文字化して _id にする。
 * passphrase が指定されていれば Obsidian LiveSync 互換の Path Obfuscation を適用する。
 */
export function path2id(filePath: string, passphrase: string | undefined, caseInsensitive = true): string {
  if (!passphrase) {
    let x = caseInsensitive ? filePath.toLowerCase() : filePath;
    if (x.startsWith("_")) x = "/" + x;
    return x;
  }

  if (filePath.startsWith(PREFIX_OBFUSCATED)) return filePath;

  let filename = filePath;
  if (caseInsensitive) {
    filename = filename.toLowerCase();
  }
  let x = filename;
  if (x.startsWith("_")) x = "/" + x;

  const [prefix, body] = expandPrefix(x);
  if (body.startsWith(PREFIX_OBFUSCATED)) return x;

  const hashedPassphrase = hashString(passphrase);
  const out = hashString(`${hashedPassphrase}:${filename}`);
  return prefix + PREFIX_OBFUSCATED + out;
}

export function isObfuscatedId(id: string): boolean {
  return id.startsWith(PREFIX_OBFUSCATED);
}

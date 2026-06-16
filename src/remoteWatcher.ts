import { CouchDbClient } from "./couchdb";
import { LiveSyncLogger } from "./log";

const POLL_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error && cause.name === "AbortError";
}

/**
 * CouchDB の `/_changes?feed=longpoll` を使い、リモートに変更があった瞬間に
 * コールバックを呼び出すリアルタイム監視クラス。
 *
 * - `start()` で監視ループを開始、`stop()` で停止。
 * - 接続エラー時は指数バックオフで再試行する。
 * - `makeClient` が `undefined` を返す間（未設定時）は 5 秒ごとに再確認する。
 */
export class RemoteWatcher {
  private abortController: AbortController | undefined;
  private stopped = true;

  constructor(
    /** 最新の認証情報で CouchDbClient を返す。未設定時は undefined を返す。 */
    private readonly makeClient: () => Promise<CouchDbClient | undefined>,
    /** 最後に既知のリモートシーケンスを返す（checkpoint の remoteChangesSince）。 */
    private readonly getLastSeq: () => string | number | undefined,
    /** 変更が検出されたときに呼ばれるコールバック。 */
    private readonly onChangesDetected: () => void,
    private readonly logger: LiveSyncLogger
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
    this.logger.info("Remote watcher started.");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async loop(): Promise<void> {
    let retryDelayMs = 0;

    while (!this.stopped) {
      if (retryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        if (this.stopped) break;
      }

      const client = await this.makeClient();
      if (!client) {
        retryDelayMs = 5_000;
        continue;
      }

      try {
        const since = this.getLastSeq() ?? "now";
        this.abortController = new AbortController();
        const result = await client.pollChanges(since, POLL_TIMEOUT_MS, this.abortController.signal);

        if (this.stopped) break;

        if (result.changes.length > 0) {
          this.logger.info(`Remote watcher: ${result.changes.length} remote change(s) detected.`);
          this.onChangesDetected();
        }

        retryDelayMs = 0;
      } catch (error) {
        if (this.stopped || isAbortError(error)) break;

        const msg = error instanceof Error ? error.message : String(error);
        retryDelayMs = retryDelayMs === 0
          ? RECONNECT_BASE_DELAY_MS
          : Math.min(retryDelayMs * 2, RECONNECT_MAX_DELAY_MS);
        this.logger.warn(`Remote watcher error (retry in ${retryDelayMs}ms): ${msg}`);
      }
    }

    this.logger.info("Remote watcher stopped.");
  }
}

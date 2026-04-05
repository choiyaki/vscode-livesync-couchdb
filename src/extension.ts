import * as vscode from "vscode";
import { ensureConfigured, getConfig, setConfigValue } from "./config";
import { CouchDbClient } from "./couchdb";
import { LocalReplicaStore } from "./localReplicaStore";
import { LiveSyncLogger } from "./log";
import { MetadataStore } from "./metadataStore";
import { getPassword, setPassword } from "./secrets";
import { LiveSyncStatusBar } from "./status";
import { SyncService } from "./syncService";
import { matchesFileConfig } from "./workspaceFiles";

let runningSync: Promise<void> | undefined;
let runningAutoPull: Promise<void> | undefined;
let syncQueue: Promise<void> = Promise.resolve();
const latestSaveUris = new Map<string, vscode.Uri>();
const scheduledSavePushes = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const logger = new LiveSyncLogger();
  const statusBar = new LiveSyncStatusBar();
  const metadata = new MetadataStore(context.storageUri);
  const localReplica = new LocalReplicaStore(context.storageUri);

  const saveDirtyDocuments = async (): Promise<boolean> => {
    const dirtyDocuments = vscode.workspace.textDocuments.filter(
      (document) => !document.isUntitled && document.isDirty
    );

    if (dirtyDocuments.length === 0) {
      return true;
    }

    const results = await Promise.all(dirtyDocuments.map((document) => document.save()));
    if (results.every(Boolean)) {
      logger.info(`Saved ${dirtyDocuments.length} dirty document(s) before sync.`);
      return true;
    }

    logger.warn("Push cancelled because one or more dirty documents could not be saved.");
    vscode.window.showWarningMessage("LiveSync: Could not save all modified files. Push was cancelled.");
    return false;
  };

  context.subscriptions.push(
    { dispose: () => logger.dispose() },
    { dispose: () => statusBar.dispose() }
  );

  const runWithClient = async <T>(label: string, callback: (service: SyncService) => Promise<T>): Promise<T | undefined> => {
    await metadata.initialize();
    await localReplica.initialize();
    const config = getConfig();
    if (!(await ensureConfigured(config))) {
      return undefined;
    }

    const password = await getPassword(context);
    if (!password) {
      vscode.window.showWarningMessage("LiveSync CouchDB password is not set. Run 'LiveSync: Configure CouchDB'.");
      return undefined;
    }

    const client = new CouchDbClient(config, password);
    const service = new SyncService(config, client, logger, metadata, localReplica);
    statusBar.setBusy(label);
    try {
      return await callback(service);
    } catch (error) {
      logger.error(`${label} failed`, error);
      statusBar.setError(label);
      vscode.window.showErrorMessage(`LiveSync ${label} failed. See output for details.`);
      return undefined;
    } finally {
      statusBar.setIdle();
    }
  };

  const enqueueSyncOperation = async (operation: () => Promise<void>): Promise<void> => {
    const pending = syncQueue.catch(() => undefined).then(operation);
    syncQueue = pending.catch(() => undefined);
    await pending;
  };

  const register = (command: string, handler: () => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  const scheduleSavePush = (uri: vscode.Uri): void => {
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    latestSaveUris.set(relativePath, uri);

    if (scheduledSavePushes.has(relativePath)) {
      return;
    }

    scheduledSavePushes.add(relativePath);
    void enqueueSyncOperation(async () => {
      try {
        while (true) {
          const latestUri = latestSaveUris.get(relativePath);
          if (!latestUri) {
            break;
          }

          latestSaveUris.delete(relativePath);
          await runWithClient("save-sync", async (service) => {
            const result = await service.pushSingle(latestUri);
            if (result.pushed > 0) {
              logger.info(`Saved file pushed: ${latestUri.fsPath}`);
            }
          });
        }
      } finally {
        scheduledSavePushes.delete(relativePath);

        if (latestSaveUris.has(relativePath)) {
          scheduleSavePush(latestSaveUris.get(relativePath)!);
        }
      }
    });
  };

  register("livesync.configure", async () => {
    const current = getConfig();
    const url = await vscode.window.showInputBox({ prompt: "CouchDB base URL", value: current.url, ignoreFocusOut: true });
    if (url === undefined) {
      return;
    }

    const database = await vscode.window.showInputBox({ prompt: "CouchDB database name", value: current.database, ignoreFocusOut: true });
    if (database === undefined) {
      return;
    }

    const username = await vscode.window.showInputBox({ prompt: "CouchDB username", value: current.username, ignoreFocusOut: true });
    if (username === undefined) {
      return;
    }

    const password = await vscode.window.showInputBox({ prompt: "CouchDB password", password: true, ignoreFocusOut: true });
    if (password === undefined) {
      return;
    }

    await setConfigValue("couchdb.url", url.trim());
    await setConfigValue("couchdb.database", database.trim());
    await setConfigValue("couchdb.username", username.trim());
    await setPassword(context, password);
    logger.info("CouchDB configuration updated.");
    vscode.window.showInformationMessage("LiveSync CouchDB configuration saved.");
  });

  register("livesync.testConnection", async () => {
    await runWithClient("testConnection", async () => {
      const config = getConfig();
      const password = await getPassword(context);
      const client = new CouchDbClient(config, password);
      await client.testConnection();
      logger.info(`Connected to ${config.url}/${config.database}`);
      vscode.window.showInformationMessage("LiveSync CouchDB connection succeeded.");
    });
  });

  register("livesync.pushNow", async () => {
    if (!(await saveDirtyDocuments())) {
      return;
    }

    await enqueueSyncOperation(async () => {
      await runWithClient("push", async (service) => {
        const result = await service.pushAll();
        logger.info(`Push finished: pushed=${result.pushed}, skipped=${result.skipped}, conflicts=${result.conflicts.length}`);
        vscode.window.showInformationMessage(`LiveSync push finished. pushed=${result.pushed}, conflicts=${result.conflicts.length}`);
      });
    });
  });

  register("livesync.pullNow", async () => {
    await enqueueSyncOperation(async () => {
      await runWithClient("pull", async (service) => {
        logger.show();
        const result = await service.pullIncremental();
        logger.info(`Pull finished: pulled=${result.pulled}, skipped=${result.skipped}, conflicts=${result.conflicts.length}`);
        vscode.window.showInformationMessage(`LiveSync pull finished. pulled=${result.pulled}, conflicts=${result.conflicts.length}`);
      });
    });
  });

  register("livesync.pullFullNow", async () => {
    await enqueueSyncOperation(async () => {
      await runWithClient("full-pull", async (service) => {
        logger.show();
        const result = await service.pullAll();
        logger.info(`Full pull finished: pulled=${result.pulled}, skipped=${result.skipped}, conflicts=${result.conflicts.length}`);
        vscode.window.showInformationMessage(`LiveSync full pull finished. pulled=${result.pulled}, conflicts=${result.conflicts.length}`);
      });
    });
  });

  register("livesync.showConflicts", async () => {
    await metadata.initialize();
    const conflicts = metadata.listConflicts();
    if (conflicts.length === 0) {
      vscode.window.showInformationMessage("LiveSync: No conflicts detected.");
      return;
    }

    const selected = await vscode.window.showQuickPick(conflicts, {
      placeHolder: "Select a conflicted file to compare or resolve",
    });
    if (!selected) {
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: "$(diff) Show Diff", description: "Open side-by-side diff viewer", id: "diff" },
        { label: "$(arrow-up) Accept Local", description: "Push local copy to remote and clear conflict", id: "local" },
        { label: "$(arrow-down) Accept Remote", description: "Overwrite local copy with remote and clear conflict", id: "remote" },
      ],
      { placeHolder: `Choose action for: ${selected}` }
    );
    if (!action) {
      return;
    }

    if (action.id === "diff") {
      await runWithClient("diff", async (service) => {
        const remoteDiff = await service.fetchRemoteForDiff(selected);
        if (!remoteDiff) {
          vscode.window.showWarningMessage(`LiveSync: No remote document found for "${selected}".`);
          return;
        }

        if (!context.storageUri) {
          vscode.window.showErrorMessage("LiveSync: storageUri is unavailable, cannot show diff.");
          return;
        }

        const tempDir = vscode.Uri.joinPath(context.storageUri, "conflict-preview");
        await vscode.workspace.fs.createDirectory(tempDir);
        const basename = selected.split("/").pop() ?? selected;
        const hex = Buffer.from(selected).toString("hex");
        const tempUri = vscode.Uri.joinPath(tempDir, `${hex}-${basename}`);
        const remoteContent = remoteDiff.content;
        await vscode.workspace.fs.writeFile(tempUri, Buffer.from(remoteContent, "utf8"));

        const localUri = CouchDbClient.toUri(selected);
        if (!localUri) {
          return;
        }

        await vscode.commands.executeCommand(
          "vscode.diff",
          tempUri,
          localUri,
          `Remote ↔ Local: ${selected}`
        );
      });
    } else {
      const choice = action.id as "local" | "remote";
      await runWithClient("resolve", async (service) => {
        await service.resolveConflict(selected, choice);
        vscode.window.showInformationMessage(
          `LiveSync: Conflict resolved (${choice === "local" ? "accepted local" : "accepted remote"}): ${selected}`
        );
      });
    }
  });

  register("livesync.resolveConflict", async () => {
    await vscode.commands.executeCommand("livesync.showConflicts");
  });

  register("livesync.syncNow", async () => {
    if (runningSync || runningAutoPull) {
      logger.warn("Sync already in progress.");
      return;
    }

    if (!(await saveDirtyDocuments())) {
      return;
    }

    runningSync = enqueueSyncOperation(async () => {
      await runWithClient("sync", async (service) => {
        logger.show();
        const result = await service.pushAll().then(async (push) => {
          const pull = await service.pullIncremental();
          return {
            pushed: push.pushed,
            pulled: pull.pulled,
            skipped: push.skipped + pull.skipped,
            conflicts: [...push.conflicts, ...pull.conflicts],
          };
        });
        logger.info(`Sync finished: pushed=${result.pushed}, pulled=${result.pulled}, skipped=${result.skipped}, conflicts=${result.conflicts.length}`);
        vscode.window.showInformationMessage(`LiveSync sync finished. pushed=${result.pushed}, pulled=${result.pulled}, conflicts=${result.conflicts.length}`);
      });
    }).then(() => undefined);

    await runningSync;
    runningSync = undefined;
  });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const saveSubscription = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
    if (document.isUntitled) {
      return;
    }

    const config = getConfig();
    if (!config.syncOnSave) {
      return;
    }

    const relPath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
    if (!matchesFileConfig(relPath, config)) {
      return;
    }

    scheduleSavePush(document.uri);
  });

  const deleteSubscription = watcher.onDidDelete(async (uri: vscode.Uri) => {
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    const config = getConfig();
    if (!matchesFileConfig(relativePath, config)) {
      return;
    }
    await enqueueSyncOperation(async () => {
      await runWithClient("delete-sync", async (service) => {
        const deleted = await service.pushDeletion(relativePath);
        if (deleted) {
          logger.info(`Deleted remote document: ${relativePath}`);
        }
      });
    });
  });

  context.subscriptions.push(watcher, saveSubscription, deleteSubscription);

  // ── Startup sync ──────────────────────────────────────────
  const startupConfig = getConfig();
  if (startupConfig.syncOnStartup) {
    setImmediate(() => {
      runningSync = enqueueSyncOperation(async () => {
        await runWithClient("startup-sync", async (service) => {
          logger.show();
          const push = await service.pushAll();
          const pull = await service.pullIncremental();
          logger.info(
            `Startup sync finished: pushed=${push.pushed}, pulled=${pull.pulled}, skipped=${push.skipped + pull.skipped}, conflicts=${push.conflicts.length + pull.conflicts.length}`
          );
        });
      })
        .then(() => undefined)
        .catch((err: unknown) => {
          logger.error("Startup sync failed", err);
        })
        .finally(() => {
          runningSync = undefined;
        });
    });
  }

  // ── Auto-pull timer ───────────────────────────────────────
  const intervalSec = startupConfig.autoSyncIntervalSeconds;
  if (intervalSec > 0) {
    const timer = setInterval(() => {
      if (runningSync || runningAutoPull) {
        return;
      }

      runningAutoPull = enqueueSyncOperation(async () => {
        await runWithClient("auto-pull", async (service) => {
          const result = await service.pullIncremental();
          if (result.pulled > 0 || result.conflicts.length > 0) {
            logger.info(`Auto-pull: pulled=${result.pulled}, conflicts=${result.conflicts.length}`);
          }
        });
      })
        .then(() => undefined)
        .catch((err: unknown) => {
          logger.error("Auto-pull failed", err);
        })
        .finally(() => {
          runningAutoPull = undefined;
        });
    }, intervalSec * 1000);

    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    logger.info(`Auto-pull timer started: every ${intervalSec}s`);
  }

  logger.info("LiveSync CouchDB extension activated.");
}

export function deactivate(): void {
  return;
}
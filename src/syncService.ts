import * as path from "node:path";
import * as vscode from "vscode";
import { CouchDbClient } from "./couchdb";
import { LocalReplicaStore } from "./localReplicaStore";
import { LiveSyncLogger } from "./log";
import { MetadataStore } from "./metadataStore";
import { LiveSyncConfig, RemoteDocument, SyncResult } from "./types";
import { getRelativePath, hashText, listWorkspaceFiles, matchesFileConfig, readWorkspaceFile } from "./workspaceFiles";

function emptyResult(): SyncResult {
  return { pushed: 0, pulled: 0, skipped: 0, conflicts: [] };
}

export class SyncService {
  constructor(
    private readonly config: LiveSyncConfig,
    private readonly client: CouchDbClient,
    private readonly logger: LiveSyncLogger,
    private readonly metadata: MetadataStore,
    private readonly localReplica: LocalReplicaStore
  ) {}

  async pushAll(): Promise<SyncResult> {
    const result = emptyResult();
    let mismatchLogCount = 0;
    const uris = await listWorkspaceFiles(this.config);
    const localPathSet = new Set<string>();
    for (const uri of uris) {
      localPathSet.add(getRelativePath(uri));
    }
    for (const trackedPath of this.localReplica.listPaths()) {
      const tracked = this.localReplica.get(trackedPath);
      if (!tracked || tracked.deleted || localPathSet.has(trackedPath)) {
        continue;
      }
      const response = await this.client.tombstoneDocument(trackedPath, Date.now());
      if (response) {
        await this.localReplica.markDeleted(trackedPath, response.rev, Date.now());
        await this.metadata.clearConflict(trackedPath);
        result.pushed += 1;
        this.logger.info(`Pushed tombstone for deleted file: ${trackedPath}`);
      }
    }
    for (const uri of uris) {
      const relativePath = getRelativePath(uri);
      const trackedReplica = this.localReplica.get(relativePath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (trackedReplica && !trackedReplica.deleted && trackedReplica.localMtime === stat.mtime) {
        result.skipped += 1;
        continue;
      }

      const file = await readWorkspaceFile(uri);
      const replica = this.localReplica.get(file.relativePath);
      if (replica && !replica.deleted && replica.contentHash === file.contentHash) {
        result.skipped += 1;
        continue;
      }

      const remote = await this.client.getDocument(file.relativePath);
      if (remote && !remote.deleted) {
        const remoteContent = await this.client.assembleContent(remote);
        const remoteHash = hashText(remoteContent);
        if (remoteHash === file.contentHash) {
          await this.localReplica.upsert(this.toReplicaEntry(file.relativePath, file.contentHash, file.mtime, remote._rev, remote.mtime, false));
          await this.metadata.clearConflict(file.relativePath);
          result.skipped += 1;
          continue;
        }
        if (this.hasRemoteConflict(replica?.remoteRev, remote._rev, file.contentHash, remoteHash)) {
          result.conflicts.push(file.relativePath);
          this.logger.warn(`Push skipped due to remote-rev conflict: ${file.relativePath}`);
          await this.metadata.setConflict(file.relativePath, remote._rev);
          continue;
        }

        if (mismatchLogCount < 20) {
          this.logger.info(
            `Push mismatch without conflict: path=${file.relativePath}, trackedRev=${replica?.remoteRev ?? ""}, remoteRev=${remote._rev ?? ""}, localHash=${file.contentHash}, remoteHash=${remoteHash}, localLength=${file.content.length}, remoteLength=${remoteContent.length}`
          );
          mismatchLogCount += 1;
        }
      }
      const response = await this.client.upsertDocument({
        _id: file.relativePath, type: "plain", path: file.relativePath,
        data: file.content, mtime: file.mtime, deleted: false
      }, remote?._rev);
      await this.localReplica.upsert(this.toReplicaEntry(file.relativePath, file.contentHash, file.mtime, response.rev, file.mtime, false));
      await this.metadata.clearConflict(file.relativePath);
      result.pushed += 1;
    }
    return result;
  }

  async pullAll(): Promise<SyncResult> {
    const result = emptyResult();
    const docs = await this.client.listDocuments();
    await this.applyRemoteDocuments(docs, result);
    await this.localReplica.updateCheckpoint({ remoteChangesSince: await this.client.getLatestSequence() });
    return result;
  }

  async pullIncremental(): Promise<SyncResult> {
    const result = emptyResult();
    const since = this.localReplica.getCheckpoint().remoteChangesSince;
    if (!since) {
      return await this.pullAll();
    }

    const changes = await this.client.listChanges(since);
    const deletedDocs: RemoteDocument[] = [];
    const changedIds = new Set<string>();

    for (const change of changes.changes) {
      const replica = this.localReplica.get(change.id);
      if (replica?.remoteRev && change.rev && replica.remoteRev === change.rev) {
        result.skipped += 1;
        this.logger.info(`Pull skipped (rev unchanged): ${change.id}`);
        continue;
      }

      if (change.deleted) {
        if (replica?.deleted) {
          result.skipped += 1;
          continue;
        }

        deletedDocs.push({
          _id: change.id,
          _rev: change.rev,
          path: change.id,
          type: "plain",
          mtime: 0,
          deleted: true,
        });
        continue;
      }

      changedIds.add(change.id);
    }

    const changedDocs = changedIds.size > 0
      ? await this.client.getDocumentsByIds([...changedIds])
      : [];
    await this.applyRemoteDocuments([...deletedDocs, ...changedDocs], result);
    await this.localReplica.updateCheckpoint({ remoteChangesSince: changes.lastSeq });
    return result;
  }

  async syncNow(): Promise<SyncResult> {
    const push = await this.pushAll();
    const pull = await this.pullAll();
    return { pushed: push.pushed, pulled: pull.pulled, skipped: push.skipped + pull.skipped, conflicts: [...push.conflicts, ...pull.conflicts] };
  }

  async pushSingle(uri: vscode.Uri): Promise<SyncResult> {
    const result = emptyResult();
    const relativePath = getRelativePath(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    const trackedReplica = this.localReplica.get(relativePath);
    if (trackedReplica && !trackedReplica.deleted && trackedReplica.localMtime === stat.mtime) {
      result.skipped = 1;
      return result;
    }

    const file = await readWorkspaceFile(uri);
    const replica = this.localReplica.get(relativePath);
    if (replica && !replica.deleted && replica.contentHash === file.contentHash) {
      result.skipped = 1;
      return result;
    }

    const remote = await this.client.getDocument(relativePath);
    if (remote && !remote.deleted) {
      const remoteContent = await this.client.assembleContent(remote);
      const remoteHash = hashText(remoteContent);
      if (remoteHash === file.contentHash) {
        await this.localReplica.upsert(this.toReplicaEntry(relativePath, file.contentHash, file.mtime, remote._rev, remote.mtime, false));
        await this.metadata.clearConflict(relativePath);
        result.skipped = 1;
        return result;
      }
      if (this.hasRemoteConflict(replica?.remoteRev, remote._rev, file.contentHash, remoteHash)) {
        result.conflicts.push(relativePath);
        this.logger.warn(`Save sync skipped due to remote-rev conflict: ${relativePath}`);
        await this.metadata.setConflict(relativePath, remote._rev);
        return result;
      }
    }
    const response = await this.client.upsertDocument({
      _id: relativePath, type: "plain", path: relativePath,
      data: file.content, mtime: file.mtime, deleted: false
    }, remote?._rev);
    await this.localReplica.upsert(this.toReplicaEntry(relativePath, file.contentHash, file.mtime, response.rev, file.mtime, false));
    await this.metadata.clearConflict(relativePath);
    result.pushed = 1;
    return result;
  }

  async pushDeletion(relativePath: string): Promise<boolean> {
    const tracked = this.localReplica.get(relativePath);
    if (!tracked || tracked.deleted) { return false; }
    const response = await this.client.tombstoneDocument(relativePath, Date.now());
    if (!response) { return false; }
    await this.localReplica.markDeleted(relativePath, response.rev, Date.now());
    await this.metadata.clearConflict(relativePath);
    return true;
  }

  private async writeToLocal(relativePath: string, content: string): Promise<void> {
    const uri = CouchDbClient.toUri(relativePath);
    if (!uri) { return; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const parentPath = path.posix.dirname(relativePath);
    if (parentPath !== ".") {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, parentPath));
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  private async writeLocalDocument(document: RemoteDocument): Promise<void> {
    const content = await this.client.assembleContent(document);
    await this.writeToLocal(document.path, content);
  }

  private async deleteLocalFile(relativePath: string): Promise<void> {
    const uri = CouchDbClient.toUri(relativePath);
    if (!uri) { return; }
    try { await vscode.workspace.fs.delete(uri, { useTrash: false }); } catch { return; }
  }

  private async readLocalIfExists(uri: vscode.Uri): Promise<{ contentHash: string; mtime: number } | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      return { contentHash: hashText(content), mtime: stat.mtime };
    } catch { return undefined; }
  }

  async fetchRemoteForDiff(relativePath: string): Promise<{ content: string; doc: RemoteDocument } | undefined> {
    const doc = await this.client.getDocument(relativePath);
    if (!doc) { return undefined; }
    const content = await this.client.assembleContent(doc);
    return { content, doc };
  }

  async resolveConflict(relativePath: string, choice: "local" | "remote"): Promise<void> {
    const tracked = this.metadata.get(relativePath);
    const replica = this.localReplica.get(relativePath);
    if (choice === "local") {
      const uri = CouchDbClient.toUri(relativePath);
      if (!uri) { throw new Error(`Cannot resolve local URI for: ${relativePath}`); }
      const file = await readWorkspaceFile(uri);
      let response;
      try {
        response = await this.client.upsertDocument({
          _id: relativePath, type: "plain", path: relativePath,
          data: file.content, mtime: file.mtime, deleted: false
        }, tracked?.remoteRev ?? replica?.remoteRev);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("409")) { throw error; }
        const latest = await this.client.getDocument(relativePath);
        response = await this.client.upsertDocument({
          _id: relativePath, type: "plain", path: relativePath,
          data: file.content, mtime: file.mtime, deleted: false
        }, latest?._rev);
      }
      await this.metadata.clearConflict(relativePath);
      await this.localReplica.upsert(this.toReplicaEntry(relativePath, hashText(file.content), file.mtime, response.rev, file.mtime, false));
      this.logger.info(`Conflict resolved (accept local): ${relativePath}`);
    } else {
      const remote = await this.client.getDocument(relativePath);
      if (!remote) { throw new Error(`Remote document not found: ${relativePath}`); }
      await this.writeLocalDocument(remote);
      const uri = CouchDbClient.toUri(relativePath);
      const stat = uri ? await vscode.workspace.fs.stat(uri) : undefined;
      const remoteContent = await this.client.assembleContent(remote);
      await this.metadata.clearConflict(relativePath);
      await this.localReplica.upsert(this.toReplicaEntry(relativePath, hashText(remoteContent), stat?.mtime ?? Date.now(), remote._rev, remote.mtime, false));
      this.logger.info(`Conflict resolved (accept remote): ${relativePath}`);
    }
    void tracked;
  }

  private async applyRemoteDocuments(docs: RemoteDocument[], result: SyncResult): Promise<void> {
    for (const doc of docs) {
      const tracked = this.localReplica.get(doc.path);
      if (!matchesFileConfig(doc.path, this.config)) {
        result.skipped += 1;
        this.logger.info(`Pull skipped (excluded): ${doc.path}`);
        continue;
      }
      if (doc.deleted) {
        await this.deleteLocalFile(doc.path);
        await this.localReplica.markDeleted(doc.path, doc._rev, doc.mtime);
        await this.metadata.clearConflict(doc.path);
        result.pulled += 1;
        continue;
      }
      const target = CouchDbClient.toUri(doc.path);
      if (!target) { continue; }
      const remoteContent = await this.client.assembleContent(doc);
      if (remoteContent.length === 0) {
        const dataKind = Array.isArray(doc.data) ? "array" : typeof doc.data;
        const dataLength = typeof doc.data === "string"
          ? doc.data.length
          : Array.isArray(doc.data)
            ? doc.data.join("").length
            : 0;
        const childrenLength = doc.children?.length ?? 0;
        this.logger.warn(
          `Pull produced empty content: path=${doc.path}, type=${doc.type}, datatype=${doc.datatype ?? ""}, dataKind=${dataKind}, dataLength=${dataLength}, children=${childrenLength}, size=${doc.size ?? 0}, deleted=${doc.deleted ? "true" : "false"}`
        );
      }
      const docHash = hashText(remoteContent);
      const existing = await this.readLocalIfExists(target);
      if (existing && existing.contentHash === docHash) {
        await this.localReplica.upsert(this.toReplicaEntry(doc.path, docHash, existing.mtime, doc._rev, doc.mtime, false));
        await this.metadata.clearConflict(doc.path);
        result.skipped += 1;
        this.logger.info(`Pull skipped (content unchanged): ${doc.path}`);
        continue;
      }
      if (existing && tracked && this.hasBidirectionalConflict(tracked, existing.contentHash, doc._rev, docHash)) {
        result.conflicts.push(doc.path);
        this.logger.warn(`Pull skipped due to local-and-remote changes: ${doc.path}`);
        await this.metadata.setConflict(doc.path, doc._rev);
        continue;
      }
      await this.writeToLocal(doc.path, remoteContent);
      const stat = await vscode.workspace.fs.stat(target);
      await this.localReplica.upsert(this.toReplicaEntry(doc.path, docHash, stat.mtime, doc._rev, doc.mtime, false));
      await this.metadata.clearConflict(doc.path);
      result.pulled += 1;
    }
  }

  private toReplicaEntry(relativePath: string, contentHash: string, localMtime: number, remoteRev: string | undefined, remoteMtime: number, deleted: boolean) {
    return { path: relativePath, contentHash, localMtime, remoteRev, remoteMtime, deleted, updatedAt: Date.now() };
  }

  private hasRemoteConflict(trackedRemoteRev: string | undefined, remoteRev: string | undefined, localHash: string, remoteHash: string): boolean {
    if (!trackedRemoteRev || !remoteRev) { return false; }
    return trackedRemoteRev !== remoteRev && localHash !== remoteHash;
  }

  private hasBidirectionalConflict(tracked: { remoteRev?: string; contentHash: string }, existingLocalHash: string, remoteRev: string | undefined, remoteHash: string): boolean {
    const localChangedSinceLastSync = existingLocalHash !== tracked.contentHash;
    const remoteChangedSinceLastSync = !!tracked.remoteRev && !!remoteRev && tracked.remoteRev !== remoteRev;
    const differentContentsNow = existingLocalHash !== remoteHash;
    return localChangedSinceLastSync && remoteChangedSinceLastSync && differentContentsNow;
  }
}
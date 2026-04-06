import * as vscode from "vscode";
import { LocalReplicaCheckpoint, LocalReplicaDocument } from "./types";

interface LocalReplicaFileShape {
  version: 1;
  documents: Record<string, LocalReplicaDocument>;
  checkpoint: LocalReplicaCheckpoint;
}

function defaultCheckpoint(): LocalReplicaCheckpoint {
  return {
    updatedAt: 0,
  };
}

export class LocalReplicaStore {
  private readonly documents = new Map<string, LocalReplicaDocument>();
  private readonly docIdToPath = new Map<string, string>();
  private checkpoint: LocalReplicaCheckpoint = defaultCheckpoint();
  private initialized = false;

  constructor(private readonly storageUri: vscode.Uri | undefined) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.storageUri) {
      this.initialized = true;
      return;
    }

    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.fileUri())).toString("utf8");
      const parsed = JSON.parse(raw) as Partial<LocalReplicaFileShape>;
      for (const [path, document] of Object.entries(parsed.documents ?? {})) {
        this.documents.set(path, document);
        if (document.documentId) {
          this.docIdToPath.set(document.documentId, path);
        }
      }
      this.checkpoint = parsed.checkpoint ?? defaultCheckpoint();
    } catch {
      // No persisted state yet.
    }

    this.initialized = true;
  }

  get(path: string): LocalReplicaDocument | undefined {
    return this.documents.get(path);
  }

  getPathByDocumentId(docId: string): string | undefined {
    return this.docIdToPath.get(docId);
  }

  listPaths(): string[] {
    return [...this.documents.keys()];
  }

  listDocuments(): LocalReplicaDocument[] {
    return [...this.documents.values()];
  }

  getCheckpoint(): LocalReplicaCheckpoint {
    return this.checkpoint;
  }

  async upsert(document: LocalReplicaDocument): Promise<void> {
    this.documents.set(document.path, document);
    if (document.documentId) {
      this.docIdToPath.set(document.documentId, document.path);
    }
    await this.persist();
  }

  async markDeleted(path: string, remoteRev: string | undefined, remoteMtime: number): Promise<void> {
    const existing = this.documents.get(path);
    const next: LocalReplicaDocument = {
      path,
      documentId: existing?.documentId,
      contentHash: "",
      localMtime: existing?.localMtime ?? 0,
      remoteRev,
      remoteMtime,
      deleted: true,
      updatedAt: Date.now(),
    };
    this.documents.set(path, next);
    await this.persist();
  }

  async remove(path: string): Promise<void> {
    this.documents.delete(path);
    await this.persist();
  }

  async updateCheckpoint(checkpoint: Partial<LocalReplicaCheckpoint>): Promise<void> {
    this.checkpoint = {
      ...this.checkpoint,
      ...checkpoint,
      updatedAt: Date.now(),
    };
    await this.persist();
  }

  getStats(): { documents: number; deleted: number; checkpointUpdatedAt: number } {
    const all = [...this.documents.values()];
    return {
      documents: all.length,
      deleted: all.filter((document) => document.deleted).length,
      checkpointUpdatedAt: this.checkpoint.updatedAt,
    };
  }

  private fileUri(): vscode.Uri {
    if (!this.storageUri) {
      throw new Error("Workspace storageUri is unavailable.");
    }

    return vscode.Uri.joinPath(this.storageUri, "livesync-local-replica.json");
  }

  private async persist(): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    await vscode.workspace.fs.createDirectory(this.storageUri);
    const file: LocalReplicaFileShape = {
      version: 1,
      documents: Object.fromEntries(this.documents.entries()),
      checkpoint: this.checkpoint,
    };
    await vscode.workspace.fs.writeFile(this.fileUri(), Buffer.from(JSON.stringify(file, null, 2), "utf8"));
  }
}
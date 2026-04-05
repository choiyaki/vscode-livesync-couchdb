import * as vscode from "vscode";

export interface LocalMetadataEntry {
  path: string;
  remoteRev?: string;
  conflicted: boolean;
  updatedAt: number;
}

interface MetadataFileShape {
  version: 1;
  entries: Record<string, LocalMetadataEntry>;
}

export class MetadataStore {
  private readonly state = new Map<string, LocalMetadataEntry>();
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
      const parsed = JSON.parse(raw) as MetadataFileShape;
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (!value?.conflicted) {
          continue;
        }

        this.state.set(key, {
          path: value.path ?? key,
          remoteRev: value.remoteRev,
          conflicted: true,
          updatedAt: value.updatedAt ?? 0,
        });
      }
    } catch {
      // No persisted state yet.
    }

    this.initialized = true;
  }

  get(relativePath: string): LocalMetadataEntry | undefined {
    return this.state.get(relativePath);
  }

  listConflicts(): string[] {
    return [...this.state.entries()]
      .filter(([, entry]) => entry.conflicted)
      .map(([key]) => key);
  }

  async setConflict(relativePath: string, remoteRev?: string): Promise<void> {
    this.state.set(relativePath, {
      path: relativePath,
      remoteRev,
      conflicted: true,
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async clearConflict(relativePath: string): Promise<void> {
    if (!this.state.has(relativePath)) {
      return;
    }

    this.state.delete(relativePath);
    await this.persist();
  }

  async upsert(entry: LocalMetadataEntry): Promise<void> {
    this.state.set(entry.path, entry);
    await this.persist();
  }

  async remove(relativePath: string): Promise<void> {
    this.state.delete(relativePath);
    await this.persist();
  }

  private fileUri(): vscode.Uri {
    if (!this.storageUri) {
      throw new Error("Workspace storageUri is unavailable.");
    }

    return vscode.Uri.joinPath(this.storageUri, "livesync-metadata.json");
  }

  private async persist(): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    await vscode.workspace.fs.createDirectory(this.storageUri);
    const file: MetadataFileShape = {
      version: 1,
      entries: Object.fromEntries(this.state.entries())
    };
    await vscode.workspace.fs.writeFile(this.fileUri(), Buffer.from(JSON.stringify(file, null, 2), "utf8"));
  }
}

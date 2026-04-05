# LiveSync CouchDB for VS Code

CouchDB-only LiveSync extension for VS Code workspaces.

This extension is aimed at practical bidirectional sync of normal text notes between VS Code and Obsidian through a CouchDB database that is compatible with Obsidian Self-hosted LiveSync note documents.

## Current Scope

Implemented now:

- CouchDB connection configuration from VS Code settings
- Password storage via VS Code SecretStorage
- CouchDB connection test command
- Obsidian-compatible note read and write format for normal text notes
- Save-triggered push for supported files
- Delete-triggered tombstone push
- Incremental pull based on CouchDB `_changes`
- Manual incremental pull and manual full pull commands
- Manual sync command using push plus incremental pull
- Optional startup sync
- Optional auto-pull timer
- Conflict list, diff preview, and accept-local or accept-remote resolution
- Local replica store for sync state and `_changes` checkpoint persistence
- Hidden-path exclusion for dot-prefixed paths such as `.obsidian` and `.vscode`
- Output channel and status indication

Intentionally out of scope for now:

- Full Self-hosted LiveSync feature parity
- P2P or object storage backends
- Hidden file sync
- Plugin and configuration sync
- Database rebuild and maintenance workflows
- Binary attachment sync

## Commands

- `LiveSync: Configure CouchDB`
- `LiveSync: Test CouchDB Connection`
- `LiveSync: Push Now`
- `LiveSync: Pull Now`
- `LiveSync: Full Pull Now`
- `LiveSync: Sync Now`
- `LiveSync: Show Conflicts`
- `LiveSync: Resolve Conflict`

Behavior summary:

- `Push Now`: scans supported workspace files and pushes local changes to CouchDB
- `Pull Now`: incremental pull using the stored `_changes` checkpoint when available
- `Full Pull Now`: full remote scan and full local application pass
- `Sync Now`: `pushAll()` followed by incremental pull

## Automatic Behavior

- Save sync: when `livesync.syncOnSave` is enabled, saving a supported file pushes that file automatically
- Delete sync: deleting a supported file pushes a tombstone automatically
- Startup sync: when `livesync.syncOnStartup` is enabled, extension activation runs `pushAll()` followed by incremental pull
- Auto-pull: when `livesync.autoSyncIntervalSeconds` is greater than `0`, the extension periodically runs incremental pull

Save-triggered push is coalesced per file so frequent autosave updates do not enqueue an unbounded number of stale push jobs.

## Settings

The extension contributes these settings:

- `livesync.couchdb.url`
- `livesync.couchdb.database`
- `livesync.couchdb.username`
- `livesync.syncOnSave`
- `livesync.syncOnStartup`
- `livesync.autoSyncIntervalSeconds`
- `livesync.include`
- `livesync.exclude`

Current defaults are note-focused:

- include: `**/*.{md,txt,markdown}`
- exclude: `**/.git/**,**/node_modules/**,**/.obsidian/**,**/.vscode/**,**/.DS_Store`

In addition to configured excludes, dot-prefixed path segments are ignored in code.

## Conflict Handling

When both local and remote changed in incompatible ways, the extension records a conflict and does not overwrite either side automatically.

From `LiveSync: Show Conflicts`, you can:

- open a side-by-side diff between remote and local content
- accept local and push the current local file to remote
- accept remote and overwrite the local file with remote content

## Notes on Performance

- Auto-pull uses CouchDB `_changes` checkpoints instead of rescanning the full database each time
- Incremental pull skips already-known remote revisions using the local replica store
- Push decisions are replica-based, so unchanged local files are skipped before unnecessary work
- `Pull Now` is intended for normal daily use
- `Full Pull Now` is the fallback when you want a full rescan

## Development

Build:

```sh
npm run compile
```

Watch:

```sh
npm run watch
```

If you open the parent workspace, use the root launch and task configuration.
If you open only `vscode-livesync-couchdb`, use the subproject launch and task configuration.

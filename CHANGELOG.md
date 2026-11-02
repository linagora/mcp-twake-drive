# Changelog

All notable changes to mcp-twake-drive are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `cursor` and `next_cursor` on `list_recent_files` and `list_favorites`.

### Changed
- All stack access goes through `cozy-client`, with indexed queries for recent files and favourites.
- The search index is built at the first `search_files`, not at launch.
- `list_recent_files` with `in_path` covers the files directly inside the folder, and the path must match exactly.
- `list_share_links` and `revoke_share_link` go through every page of links.
- `on_conflict: rename` counts from ` (1)`, and tells the free name before sending the file.
- Stack errors read `HTTP <status> (<detail>)`, without the method and the route.
- Sizes read `512 Bytes` and `1 KB`, not `512 B` and `1.0 KB`, and a downloaded copy counts from ` (1)` like `on_conflict: rename`.
- The `web_app` address and public links end with `#/`.
- `create_folder` without `parents` names the direct parent when it is missing.

### Removed
- `TWAKE_DRIVE_TIMEOUT_MS`: cozy-client has no request timeout.
- `TWAKE_DRIVE_APP_URL`: links always use the `<instance>-drive.<domain>` form.

## [0.3.0] - 2026-11-02

### Changed
- `download_file` writes inside `TWAKE_DRIVE_DOWNLOAD_DIR` only and never replaces an existing file: `save_to` outside that folder or on an existing file is refused.
- `upload_file` and `update_file_content` read `local_path` from `TWAKE_DRIVE_UPLOAD_DIR` only, which defaults to `TWAKE_DRIVE_DOWNLOAD_DIR`. To upload a local file from elsewhere, copy it there or set this variable.
- `read_file` returns an error on a note whose archive has no readable `index.md`, including one cut short, which used to return its beginning.

## [0.2.0] - 2026-11-01

### Added
- Prior approval of every write by the user, asked by the server itself through MCP elicitation (`TWAKE_DRIVE_APPROVAL=elicit`, the default): the 19 create, organise, share and delete tools show the drive, the full paths and what changes, with a unique reference, and write only on accept. Prompts in English or French (`USER_LANGUAGE`), `TWAKE_DRIVE_APPROVAL_TIMEOUT_MS`.
- `scripts/live-approval.mjs`: live test of the approvals in a temporary folder of a real drive.

### Changed
- **Breaking**: with an MCP client that does not support elicitation, write tools now return an error and write nothing. Set `TWAKE_DRIVE_APPROVAL=client` to keep the 0.1 behaviour when your client confirms writes itself.

### Fixed
- `list_folder`, `upload_file` and the other tools failed (404) on the root of a shared drive when no folder was given: the root is now the folder the shared drive shares.

## [0.1.1] - 2026-11-01

### Changed
- First npm release. Dependencies: TypeScript 7, vitest 5, @types/node 26; CI actions v7.
- The version shown at startup and to MCP clients is read from package.json.

## [0.1.0] - 2026-10-31

### Added
- First public release: 31 tools to browse, search, read, create, organise and share Twake Drive files, notes and documents, including shared drives.
- Local metadata index for fast, accent-insensitive search on large drives.
- Authentication through an external token broker (`TWAKE_DRIVE_TOKEN_COMMAND`).
- Community files: Code of Conduct, Security Policy, Contributing guide with DCO, issue and pull request templates, CI (Node 20 and 22) and Dependabot.

# Changelog

All notable changes to mcp-twake-drive are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

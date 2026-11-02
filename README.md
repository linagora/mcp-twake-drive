# mcp-twake-drive

[![npm version](https://img.shields.io/npm/v/mcp-twake-drive)](https://www.npmjs.com/package/mcp-twake-drive)
[![CI](https://github.com/linagora/mcp-twake-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/mcp-twake-drive/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Give your AI assistant secure access to Twake Drive, the file storage of the [Twake.ai](https://twake.ai) Digital Workplace.**

## What is it?

`mcp-twake-drive` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. MCP is the open standard that lets AI assistants (Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code and many others) use external tools. This server exposes your drive to the assistant as **31 tools**: browse, search, read, create, organise and share files, notes and documents.

It talks directly to the HTTP API of the **cozy-stack**, the open source server behind Twake Drive (`/files`, `/notes`, `/shortcuts`, `/permissions`, `/sharings/drives`): the same API the Twake Drive web and mobile apps use.

## Part of Twake.ai

[Twake.ai](https://twake.ai) is the truly open source and sovereign Digital Workplace developed by [LINAGORA](https://linagora.com): Twake Mail, Twake Calendar, Twake Drive, Twake Chat, Twake Space and Twake Visio with a single account, hosted in France or on your own infrastructure.

Five open source MCP servers connect AI assistants to the whole workplace:

| MCP server | Twake.ai service | Protocol |
|---|---|---|
| [mcp-twake-mail](https://github.com/linagora/mcp-twake-mail) | Twake Mail | JMAP |
| [mcp-twake-dav](https://github.com/linagora/mcp-twake-dav) | Twake Calendar and contacts | CalDAV / CardDAV |
| **mcp-twake-drive** (this project) | Twake Drive | cozy-stack API |
| [mcp-twake-chat](https://github.com/linagora/mcp-twake-chat) | Twake Chat | Matrix |
| [mcp-twake-space](https://github.com/linagora/mcp-twake-space) | Twake Space (team spaces) | Twake Space API |

Used together, they let one assistant prepare a meeting from the invitation, the related email thread, the chat discussion and the documents in the drive, without your data leaving your servers.

## What it brings

- **Find any file in seconds**: "Where is the signed contract with Example Corp?" Search is instant even on drives with tens of thousands of files.
- **Read and summarise**: text, Markdown and collaborative notes are read directly; PDF and Office files are downloaded for the assistant to analyse.
- **Produce documents**: create folders, collaborative notes from Markdown, empty Word / Excel / PowerPoint documents, or upload a file the assistant has generated.
- **Keep things tidy**: rename, move, copy, tag, mark as favourite, trash and restore, revert to a previous version.
- **Share safely**: create a read-only (or edit) public link with an optional password and expiry, and revoke it.
- **Shared drives**: work in the shared drives of your team as well as in your own drive.
- **Sovereignty**: the server runs next to your assistant and talks directly to your Twake Drive. Pair it with a self-hosted or European AI model to keep the whole chain under your control.

## Features

### 31 MCP tools

| Category | Tools |
|---|---|
| Read | `get_drive_info`, `list_folder`, `get_item`, `search_files`, `list_recent_files`, `list_favorites`, `list_trash`, `read_file`, `list_shared_drives`, `list_sharings`, `list_share_links` |
| Create | `download_file` (local copy, inside the download folder), `create_folder` (with `parents`, like `mkdir -p`), `upload_file` (local file, text or base64; `on_conflict`: error / rename / overwrite), `update_file_content`, `create_document` (empty .docx / .xlsx / .pptx), `create_note` (collaborative note, optional Markdown content), `create_shortcut`, `create_drawing` (Excalidraw) |
| Organise | `rename_item`, `move_item`, `copy_file`, `set_favorite`, `set_tags`, `trash_item`, `restore_from_trash`, `revert_version` |
| Share ⚠️ | `create_share_link` (read-only or edit, optional password and expiry), `revoke_share_link` |
| Irreversible ⚠️ | `delete_permanently` (only items already in the trash), `empty_trash` |

⚠️ = makes data public or deletes it for good. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

**Every write is approved by you first.** Before a Create, Organise, Share or Irreversible tool changes anything, in My Drive or in a shared drive, the server itself shows you the exact action through MCP elicitation (see [Prior approval](#prior-approval)) and acts only on your explicit OK. Reading, searching and downloading need no approval.

### Highlights

- **Paths or ids**: items are addressed by `id` or by absolute `path` (`/Documents/report.pdf`); items in a **shared drive** take an extra `drive_id` (from `list_shared_drives`).
- **Links back to the app**: every result carries a `url` that opens the item in the Twake Drive web app.
- **Fast search**: the cozy-stack has no server-side search (a Mango `$regex` on names scans every document and times out on large drives). Like the Twake Drive apps, the server keeps a **local metadata index** (names, folders, types, sizes, dates; no content) built from `/files/_changes`, stored with `0600` permissions and refreshed incrementally before each search. The index is only built by the first search, which takes about 15 s on a 50 000-item drive; every other tool reads the server directly. Search is case- and accent-insensitive, every word must appear in the name, with optional `type`, `class` and `in_path` filters.
- **Collaborative notes as Markdown**: `.cozy-note` files are returned as Markdown by `read_file`, and `create_note` turns Markdown into a real collaborative note.
- **No password, no OAuth flow inside**: short-lived access tokens come from an external broker you control.

## Requirements

- **Node.js** >= 20
- A **Twake Drive** account (or any cozy-stack instance)
- An **MCP client**: Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code, or any MCP-compatible assistant

## Installation

**From npm:**

```bash
npm install -g mcp-twake-drive
```

or run it on demand with `npx -y mcp-twake-drive`.

**From source:**

```bash
git clone https://github.com/linagora/mcp-twake-drive.git
cd mcp-twake-drive
npm install
npm run build          # then run: node build/index.js
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `TWAKE_DRIVE_URL` | yes | Your Twake Drive (cozy-stack) instance, e.g. `https://alice.twake.example.com` |
| `TWAKE_DRIVE_TOKEN_COMMAND` | yes\* | Command printing an OAuth access token, raw or as JSON `{"access_token": "...", "expires_at": <epoch s>}`. Called again shortly before expiry. |
| `TWAKE_DRIVE_TOKEN` | yes\* | Static token (development only) |
| `TWAKE_DRIVE_DOWNLOAD_DIR` | no | Where `download_file` writes, default `~/Downloads/twake-drive` |
| `TWAKE_DRIVE_UPLOAD_DIR` | no | Where `upload_file` and `update_file_content` read `local_path`, default `TWAKE_DRIVE_DOWNLOAD_DIR` |
| `TWAKE_DRIVE_CACHE_DIR` | no | Search index location, default `~/.cache/mcp-twake-drive` |
| `TWAKE_DRIVE_MAX_TEXT_CHARS` | no | `read_file` truncation, default `60000` |
| `TWAKE_DRIVE_APPROVAL` | no | `elicit` (default): the server asks you before every write to the drive; `client`: your MCP client confirms |
| `TWAKE_DRIVE_APPROVAL_TIMEOUT_MS` | no | How long an approval prompt waits for your answer, default `600000` |
| `USER_LANGUAGE` | no | Language of the approval prompts, `en` (default) or `fr` |

\* one of the two.

### Prior approval

With `TWAKE_DRIVE_APPROVAL=elicit` (the default), every tool that writes to the drive sends the MCP client an [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) request before it writes, for instance:

```
Twake Drive: Move
As: alice.twake.example.com (your account)
Drive: My Drive
Item: /Docs/Report.pdf (2.0 MB)
Destination: /Archives

Ref. 3f9a1c · Accept to do it now, refuse to cancel.
```

- The prompt shows the drive (My Drive or the shared drive's name), the full paths, what changes (old → new name or tags, the content of a text upload, the rights and expiry of a public link, the items an empty trash destroys).
- The server writes only on *accept*. A refusal, a dismissal, a timeout or an error changes nothing, and the tool tells the assistant not to retry.
- A client without elicitation support gets an error and nothing is written. Set `TWAKE_DRIVE_APPROVAL=client` only if your MCP client asks you to confirm every write tool itself.

### Getting a token

The server does not run an OAuth flow itself: an external broker owns the grant and hands out short-lived access tokens. This keeps the refresh token out of the MCP client configuration and lets one broker serve several tools. A broker must:

1. register an OAuth client on the instance (`POST /auth/register`);
2. send the user once to `/auth/authorize` (PKCE) with the scopes below, then exchange the code at `POST /auth/access_token`;
3. renew with the refresh token (`grant_type=refresh_token`) under a lock, and print the access token when called.

Scopes used: `io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET`.

On OIDC instances where `allow_oauth_token` is enabled, `POST /oidc/access_token` can exchange an identity-provider token directly instead (see the cozy-stack [delegated authentication](https://github.com/cozy/cozy-stack/blob/master/docs/delegated-auth.md) documentation).

## Use it with your assistant

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "twake-drive": {
      "command": "npx",
      "args": ["-y", "mcp-twake-drive"],
      "env": {
        "TWAKE_DRIVE_URL": "https://alice.twake.example.com",
        "TWAKE_DRIVE_TOKEN_COMMAND": "/usr/local/bin/my-token-broker drive-token --json"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add twake-drive --scope user \
  -e TWAKE_DRIVE_URL=https://alice.twake.example.com \
  -e "TWAKE_DRIVE_TOKEN_COMMAND=/usr/local/bin/my-token-broker drive-token --json" \
  -- npx -y mcp-twake-drive
```

### Hermes Agent

```yaml
mcp_servers:
  twake_drive:
    command: npx
    args: ["-y", "mcp-twake-drive"]
    env:
      TWAKE_DRIVE_URL: https://alice.twake.example.com
      TWAKE_DRIVE_TOKEN_COMMAND: /usr/local/bin/my-token-broker drive-token --json
      TWAKE_DRIVE_APPROVAL_TIMEOUT_MS: "330000"
      USER_LANGUAGE: fr
    timeout: 420            # longer than the approval wait
    elicitation:
      enabled: true
      timeout: 300
    tools:
      exclude: [delete_permanently, empty_trash]
```

Hermes shows the approval prompts in the desktop app, the terminal or on your messaging platform, and declines them where nobody can answer (cron jobs, one-shot queries).

### Other MCP clients

Any client that can launch a stdio MCP server works: command `npx`, arguments `-y mcp-twake-drive`, and the environment variables above.

## Recommended safe configuration

- Exclude `delete_permanently` and `empty_trash` in your MCP client: `trash_item` is enough for day-to-day use and can be undone with `restore_from_trash`.
- Keep `TWAKE_DRIVE_APPROVAL=elicit` (the default): every write waits for your OK on the exact action. Read the rights and expiry carefully before accepting `create_share_link`: a public link is reachable by **anyone** who has it.
- Keep the default `on_conflict: error` for uploads, so an existing file is never overwritten silently.

Documents may be written by third parties (prompt injection). See [SECURITY.md](SECURITY.md).

## Usage examples

- "Find the latest version of the board presentation."
- "Summarise the meeting notes in /Projects/Atlas."
- "Create a note 'Weekly review' in /Team with these points…"
- "Upload the report you just generated to /Clients/Example Corp, without replacing anything."
- "Move every PDF from /Inbox to /Archive/2026."
- "Create a read-only link to the brochure, valid for one week."

## Development

```bash
npm install
npm run build
npm test         # fake fetch and in-memory MCP client: never touches a real drive
npm run test:start   # runs the built server as a process, against a local fake server
npm run typecheck
```

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)). The Office templates come from [twake-drive-mobile](https://github.com/linagora/twake-drive-mobile) (AGPL-3.0).

Copyright © 2026 [LINAGORA](https://linagora.com)

## About

`mcp-twake-drive` is developed by [LINAGORA](https://linagora.com), French open source software publisher, as part of [Twake.ai](https://twake.ai). For support, hosting or integration of Twake.ai and its AI connectors, contact LINAGORA at <https://linagora.com>.

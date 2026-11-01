# Contributing to mcp-twake-drive

Thank you for your interest in mcp-twake-drive! This project is part of the open source ecosystem of [Twake.ai](https://twake.ai), the sovereign Digital Workplace developed by [LINAGORA](https://linagora.com). Contributions of every kind are welcome: bug reports, documentation, tests, compatibility reports with other servers, and code.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug**: open an issue with the *Bug report* template.
- **Suggest a feature or a new tool**: open an issue with the *Feature request* template, and describe the use case before the solution.
- **Report a vulnerability**: never in a public issue; follow [SECURITY.md](SECURITY.md).
- **Improve the documentation**: typos, examples, MCP client configurations, translations.
- **Send a pull request**: for anything bigger than a small fix, open an issue first so we can agree on the approach.

## Development setup

Requirements: Node.js >= 20 and npm.

```bash
git clone https://github.com/linagora/mcp-twake-drive.git
cd mcp-twake-drive
npm install
npm run build   # compile TypeScript to build/
npm test        # run the test suite (Vitest)
```

Tests never touch a real server: they use mocks and fixtures. Do not add tests that need real credentials.

### Project structure

```
src/
  config.ts        # environment validation
  drive.ts         # cozy-stack HTTP client (files, notes, sharings, permissions)
  file-index.ts    # local metadata index used by search_files
  token-command.ts # access token from an external broker
  tools.ts         # MCP tool implementations
  format.ts        # AI-friendly output
templates/         # empty Office documents used by create_document
tests/             # unit tests with a fake fetch (Vitest)
```

## Coding guidelines

- TypeScript in **strict mode**, ESM modules with `.js` import extensions (required by the MCP SDK).
- **stdout is reserved for the MCP JSON-RPC protocol**: all logs go to stderr through the logger.
- Validate tool inputs with Zod schemas, and give every tool accurate MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- Error messages say what went wrong **and** how to fix it: they are read by an AI assistant and by its user.
- A new write tool calls `approver.confirm(...)` right before writing (see `src/approval.ts`) and gets a test proving nothing is written when the user refuses (`tests/approval.test.ts`).
- Never log or return secrets (passwords, tokens, refresh tokens). Never commit real hostnames, accounts or personal data in tests or docs: use `example.com`.
- A new tool or environment variable must come with tests and an update of the README.

## Commits and pull requests

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, `chore/…`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat: add attendee support to create_event`.
- Keep pull requests focused on one concern, describe what changes and why, and link the related issue.
- Before opening the pull request: `npm run build` and `npm test` must pass (CI runs both).
- Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for any user-visible change.

## Developer Certificate of Origin

All contributions are made under the [Developer Certificate of Origin](https://developercertificate.org/). Sign off your commits to certify that you wrote the change or have the right to submit it:

```bash
git commit -s -m "fix: handle expired tokens"
```

## License

mcp-twake-drive is licensed under the [GNU Affero General Public License v3.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.

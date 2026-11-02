import { execFile } from 'node:child_process';

/**
 * Token provider backed by an external command (TWAKE_DRIVE_TOKEN_COMMAND).
 *
 * The command prints either a raw access token, or JSON
 * `{"access_token": "...", "expires_at": <epoch seconds>}`.
 * This lets an external broker own the OIDC grant (confidential client,
 * refresh-token rotation, cross-process locking) while the MCP server only
 * consumes short-lived access tokens.
 */
export class CommandTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly command: string) {}

  /** Return a valid access token, running the command only when needed. */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() + 60_000 < this.cached.expiresAt) {
      return this.cached.token;
    }
    if (!this.pending) {
      this.pending = this.run().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** Forget the cached token (e.g. after a 401). */
  invalidate(): void {
    this.cached = null;
  }

  private run(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        '/bin/sh',
        ['-c', this.command],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || '').trim().split('\n').slice(-1)[0] || error.message;
            reject(new Error(`token command failed: ${detail}`));
            return;
          }
          const out = String(stdout).trim();
          if (!out) {
            reject(new Error('token command printed nothing'));
            return;
          }
          let token = out;
          let expiresAt = Date.now() + 60_000;
          if (out.startsWith('{')) {
            try {
              const parsed = JSON.parse(out) as { access_token?: unknown; expires_at?: unknown };
              if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
                reject(new Error('token command JSON has no access_token'));
                return;
              }
              token = parsed.access_token;
              if (typeof parsed.expires_at === 'number') expiresAt = parsed.expires_at * 1000;
            } catch {
              reject(new Error('token command printed invalid JSON'));
              return;
            }
          }
          this.cached = { token, expiresAt };
          resolve(token);
        }
      );
    });
  }
}

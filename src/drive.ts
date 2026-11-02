/**
 * The cozy-client of this server, plugged on the external token source.
 *
 * A shared drive mirrors the /files routes under /sharings/drives/:drive-id,
 * which FileCollection handles when it gets a driveId.
 */
import cozyClient from 'cozy-client';
import cozyStackClient from 'cozy-stack-client';

// CommonJS packages: the default import is the class under vitest, its exports under node.
const CozyClient = (cozyClient as any).default ?? cozyClient;
const CozyStackClient = (cozyStackClient as any).default ?? cozyStackClient;

export const ROOT_DIR_ID = 'io.cozy.files.root-dir';

export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface CozyDoc {
  id: string;
  type?: string;
  attributes: Record<string, any>;
  meta?: { rev?: string };
  relationships?: Record<string, any>;
  links?: Record<string, string>;
}

/** fetchJSON calls refreshToken() on an expired or invalid token, and retries once. */
class TokenStackClient extends CozyStackClient {
  constructor(
    options: { uri: string },
    private readonly tokens: TokenSource
  ) {
    super(options);
  }

  async loadToken(): Promise<void> {
    (this as any).setToken(await this.tokens.getToken());
  }

  // The stack client's own refresh reads a web page: here the token comes from the external source.
  async refreshToken(): Promise<void> {
    this.tokens.invalidate();
    await this.loadToken();
    (this as any).onTokenRefresh((this as any).token);
  }
}

export function createCozyClient(baseUrl: string, tokens: TokenSource) {
  // A long-lived process never reads the store, and it would keep every document ever listed. Writes still land in it.
  return new CozyClient({ stackClient: new TokenStackClient({ uri: baseUrl }, tokens), disableStoreForQueries: true });
}

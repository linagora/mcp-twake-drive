import { createRequire } from 'node:module';

/** Package version, read from package.json (build/ and src/ both sit one level below it). */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** An error of the command line, written for the user, with the exit code it ends with (2 usage, 4 unavailable). */
export class CliError extends Error {
  constructor(
    readonly exitCode: 2 | 4,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

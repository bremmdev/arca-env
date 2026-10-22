/** An expected failure: printed without a stack trace, exits with `code`. */
export class ArcaError extends Error {
  constructor(
    message: string,
    public readonly code = 1,
  ) {
    super(message)
    this.name = 'ArcaError'
  }
}

/** Exit code for usage errors (unknown command or flag). */
export const EXIT_USAGE = 2

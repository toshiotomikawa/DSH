/** Stable failure of a routine operation; `code` is safe to show to the model. */
export class RoutineError extends Error {
  /** Stable machine-readable code of the refusal, safe to show to the model. */
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoutineError'
    this.code = code
  }
}

/** Sanitized failure codes; paths and underlying filesystem errors stay private. */
export class HarnessBindingError extends Error {
  /** @param code - sanitized failure identity, without filesystem details. */
  constructor(readonly code: 'binding_invalid' | 'binding_conflict' | 'binding_missing' | 'binding_stale' | 'owner_mismatch' | 'account_inactive' | 'runtime_native') {
    super(`External harness: ${code}`)
    this.name = 'HarnessBindingError'
  }
}

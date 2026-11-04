/** Sanitized failure codes; paths and underlying filesystem errors stay private. */
export class HarnessBindingError extends Error {
  /** @param code - sanitized failure identity, without filesystem details. */
  constructor(readonly code: 'binding_invalid' | 'binding_conflict' | 'binding_missing' | 'binding_stale' | 'owner_mismatch' | 'account_inactive' | 'runtime_native') {
    super(`External harness: ${code}`)
    this.name = 'HarnessBindingError'
  }
}

/** Sanitized adapter failure. The message is the code only. */
export class HarnessAdapterError extends Error {
  /** @param code - failure identity with no path, environment entry, or SDK payload. */
  constructor(readonly code: 'sdk_unavailable' | 'runtime_partial' | 'session_unavailable' | 'process_failed' | 'result_invalid') {
    super(`External harness: ${code}`)
    this.name = 'HarnessAdapterError'
  }
}

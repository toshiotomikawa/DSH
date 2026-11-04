/** Session record for an external agent runtime binding. @module */

// The module augmentation resolves the session source unless this import loads the built declaration.
import type {} from '@deepseek-ai/dsh-session/types'

/** Sidecar stored beside one DSH session. Paths stay out of it. */
export interface SessionSidecar {
  /** Account that owns the session. */
  ownerId: string
  /** Persistent agent profile. */
  agentId: string
  /** DSH session id. */
  sessionId: string
  /** External runtime named by the profile. */
  runtime: 'claude-sdk' | 'codex-sdk'
  /** Binding revision accepted for this session. */
  revision: number
  /** Stable id for this session, runtime and revision. */
  sdkSessionId: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** External runtime association for one DSH session. */
    'plugin:agent-external-runtime/session': SessionSidecar
  }
}

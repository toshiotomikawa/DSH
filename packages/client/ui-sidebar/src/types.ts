/** Safe, account-scoped sidebar projection. */
export interface AgentRuntimeSettings {
  /** Driver selected by the human profile owner. */
  runtime: 'native' | 'claude-sdk' | 'codex-sdk'
  /** Null selects the official harness default. */
  runtimeModel: string | null
  /** Explicit permission for a separate native reserve activation. */
  automaticFallback: boolean
}

/** Safe, account-scoped sidebar projection. */
export interface AgentSidebarSnapshot {
  agents: {
    id: string
    name: string
    title: string
    sectionId?: string | undefined
    revision?: number
    runtime?: AgentRuntimeSettings['runtime']
    runtimeModel?: string | undefined
    automaticFallback?: boolean
  }[]
  sections: { id: string; name: string }[]
}

/** The requested registry edit; account identity is supplied only by the carrier. */
export type AgentSidebarCommand =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'move'; id: string; sectionId: string | null }
  | { kind: 'runtime'; id: string; revision: number; settings: AgentRuntimeSettings }
  | { kind: 'clearQuota'; id: string }

/** Safe, account-scoped sidebar projection. */
export interface AgentSidebarSnapshot {
  agents: { id: string; name: string; title: string; sectionId?: string | undefined }[]
  sections: { id: string; name: string }[]
}

/** The requested registry edit; account identity is supplied only by the carrier. */
export type AgentSidebarCommand =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'move'; id: string; sectionId: string | null }

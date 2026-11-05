/** Account-scoped agent groups in the sidebar. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentRuntimeSettings, AgentSidebarCommand } from '../types.ts'
import css from './AgentSections.module.css'

/** Callbacks injected by the owning sidebar plugin. */
export interface AgentSectionsInjected {
  mutate: (command: AgentSidebarCommand) => Promise<RemoteResult<void>>
}

/** Props derived from the sidebar slot and its declared inject face. */
export type AgentSectionsProps = PropsRuntime<'sidebar.agents'> & PropsLocale<'sidebar'> & InjectFace<AgentSectionsInjected>

/** Read through the resource model; refresh only after the registry commits. */
export function AgentSections({ wide, useResource, mutate, t }: AgentSectionsProps) {
  // Reuse two addresses: the resource registry retains one source record per address.
  const [refreshKey, setRefreshKey] = useState(0)
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<{ id: string; revision: number; settings: AgentRuntimeSettings } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshot = useResource<'agent-sidebar'>(`dsh-resource://agent-sidebar/${refreshKey}`)

  async function save(command: AgentSidebarCommand) {
    setBusy(true)
    setError(null)
    try {
      const result = await mutate(command)
      if (!result.ok) { setError(result.error.message); return }
      setEditing(null)
      setDeleting(null)
      setRuntime(null)
      setRefreshKey(value => 1 - value)
    } catch (cause) {
      setError(String(cause))
    } finally { setBusy(false) }
  }

  if (!wide) return null
  const data = snapshot.status === 'live' ? snapshot.value : undefined
  return <section className={css.root} aria-label={t('agents.title')}>
    <header className={css.heading}>
      <strong>{t('agents.title')}</strong>
      <a href="/account/access">{t('agents.access')}</a>
      <button type="button" disabled={busy} onClick={() => { setRefreshKey(value => 1 - value) }}>{t('agents.refresh')}</button>
      <button type="button" disabled={busy} onClick={() => { setEditing({ name: '' }) }}>{t('agents.create')}</button>
    </header>
    {editing !== null && <form onSubmit={(event) => {
      event.preventDefault()
      void save(editing.id === undefined
        ? { kind: 'create', name: editing.name }
        : { kind: 'rename', id: editing.id, name: editing.name })
    }}>
      <label>{t('agents.name')}<input required maxLength={40} value={editing.name} disabled={busy}
        onChange={(event) => { setEditing({ ...editing, name: event.target.value }) }} /></label>
      <button disabled={busy || editing.name.trim().length === 0}>{t('agents.save')}</button>
      <button type="button" disabled={busy} onClick={() => { setEditing(null) }}>{t('agents.cancel')}</button>
    </form>}
    {error !== null && <p role="alert">{error}</p>}
    {runtime !== null && <form aria-label={t('agents.runtime')} onSubmit={(event) => {
      event.preventDefault()
      void save({ kind: 'runtime', ...runtime })
    }}>
      <label>{t('agents.runtime')}<select disabled={busy} value={runtime.settings.runtime}
        onChange={(event) => { setRuntime({ ...runtime, settings: { ...runtime.settings, runtime: event.target.value as AgentRuntimeSettings['runtime'] } }) }}>
        <option value="native">Native</option>
        <option value="claude-sdk">Claude Code</option>
        <option value="codex-sdk" disabled>Codex (partial)</option>
      </select></label>
      <label>{t('agents.runtimeModel')}<input disabled={busy} value={runtime.settings.runtimeModel ?? ''}
        onChange={(event) => {
          setRuntime({ ...runtime, settings: { ...runtime.settings, runtimeModel: event.target.value.trim() || null } })
        }} /></label>
      <label><input type="checkbox" disabled={busy} checked={runtime.settings.automaticFallback}
        onChange={(event) => {
          setRuntime({ ...runtime, settings: { ...runtime.settings, automaticFallback: event.target.checked } })
        }} />{t('agents.fallbackConsent')}</label>
      <p>{t('agents.fallbackWarning')}</p>
      <button disabled={busy}>{t('agents.save')}</button>
      <button type="button" disabled={busy} onClick={() => { setRuntime(null) }}>{t('agents.cancel')}</button>
    </form>}
    {snapshot.status === 'failed' && <p role="alert">{snapshot.failure?.message}</p>}
    {snapshot.status === 'loading' && <p role="status">{t('agents.loading')}</p>}
    {data !== undefined && <>
      {data.agents.length === 0 && <p>{t('agents.empty')}</p>}
      {[...data.sections, { id: '', name: t('agents.ungrouped') }].map(section => <div key={section.id}>
        <div className={css.heading}>
          <h3>{section.name}</h3>
          {section.id !== '' && <>
            <button type="button" disabled={busy} aria-label={t('agents.rename', { name: section.name })}
              onClick={() => { setEditing(section) }}>{t('agents.renameButton')}</button>
            <button type="button" disabled={busy} aria-label={t('agents.delete', { name: section.name })}
              onClick={() => { setDeleting(section.id) }}>{t('agents.deleteButton')}</button>
          </>}
        </div>
        {deleting === section.id && <div role="group" aria-label={t('agents.deleteConfirm')}>
          <p>{t('agents.deleteConfirm')}</p>
          <button type="button" disabled={busy} onClick={() => { void save({ kind: 'delete', id: section.id }) }}>{t('agents.confirm')}</button>
          <button type="button" disabled={busy} onClick={() => { setDeleting(null) }}>{t('agents.cancel')}</button>
        </div>}
        <ul className={css.list}>{data.agents.filter(agent => (agent.sectionId ?? '') === section.id).map((agent) => {
          const { runtime: selectedRuntime, revision } = agent
          return <li key={agent.id} className={css.agent}>
            <span title={agent.title}>{agent.name}</span>
            <select disabled={busy} aria-label={t('agents.move', { name: agent.name })} value={agent.sectionId ?? ''}
              onChange={(event) => { void save({ kind: 'move', id: agent.id, sectionId: event.target.value || null }) }}>
              <option value="">{t('agents.ungrouped')}</option>
              {data.sections.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            {selectedRuntime !== undefined && revision !== undefined && <>
              <button type="button" disabled={busy} aria-label={t('agents.configureRuntime', { name: agent.name })}
                onClick={() => { setRuntime({ id: agent.id, revision, settings: {
                  runtime: selectedRuntime, runtimeModel: agent.runtimeModel ?? null, automaticFallback: agent.automaticFallback ?? false,
                } }) }}>{t('agents.runtime')}</button>
              <button type="button" disabled={busy} aria-label={t('agents.clearQuotaFor', { name: agent.name })}
                onClick={() => { void save({ kind: 'clearQuota', id: agent.id }) }}>{t('agents.clearQuota')}</button>
            </>}
          </li>
        })}</ul>
      </div>)}
    </>}
  </section>
}

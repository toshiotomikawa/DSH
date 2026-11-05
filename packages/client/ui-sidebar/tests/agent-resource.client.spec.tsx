// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as Resources from '@deepseek-ai/dsh-client-resources/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

describe('agent sidebar resource and slot lifecycle', () => {
  it('loads through the shared resource model, routes all commands and removes the slot and provider on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.addLanguage({ id: 'pt', label: 'Português', fallback: 'en' })
      locale.setLocale('pt')
      runtime.slots.installLocale(locale)
      runtime.ctx.provide('locale', locale)
      runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
      runtime.ctx.provide('layout', { toggleSidebar: vi.fn() } as never)
      runtime.ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
      const ok = { ok: true, value: undefined } as const
      const api = {
        list: vi.fn(async (_signal?: AbortSignal) => ({ ok: true, value: {
          agents: [{ id: 'a', name: 'Ada', title: '', revision: 1, runtime: 'native' as const }], sections: [{ id: 's', name: 'Trabalho' }],
        } })),
        createSection: vi.fn(async () => ok), renameSection: vi.fn(async () => ok),
        deleteSection: vi.fn(async () => ok), moveAgent: vi.fn(async () => ok),
        setRuntime: vi.fn(async () => ok), clearQuota: vi.fn(async () => ok),
      }
      const unmountRemote = vi.fn(async () => {})
      const mountRemote = vi.spyOn(runtime.remote, '$mount').mockImplementation(async () => {
        runtime.remote.provideNamespaces({ agentSidebar: api })
        return unmountRemote
      })
      await runtime.mount(Resources)
      await runtime.declare({ sidebar: { kind: 'single', scope: 'root' } })
      const feature = await runtime.mount({ inject, apply })
      const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
      await waitFor(() => { expect(slot.view.getByText('Ada')).toBeTruthy() })
      expect(mountRemote).toHaveBeenCalledTimes(1)
      expect(api.list.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
      fireEvent.click(slot.view.getByText('Nova seção'))
      fireEvent.change(slot.view.getByLabelText('Nome da seção'), { target: { value: 'Casa' } })
      fireEvent.submit(slot.view.getByLabelText('Nome da seção').closest('form')!)
      await waitFor(() => { expect(slot.view.queryByLabelText('Nome da seção')).toBeNull() })
      expect(api.createSection).toHaveBeenCalledWith('Casa')
      await waitFor(() => { expect(slot.view.getByText('Ada')).toBeTruthy() })
      fireEvent.click(slot.view.getByLabelText('Renomear Trabalho'))
      fireEvent.change(slot.view.getByLabelText('Nome da seção'), { target: { value: 'Equipe' } })
      fireEvent.submit(slot.view.getByLabelText('Nome da seção').closest('form')!)
      await waitFor(() => { expect(slot.view.queryByLabelText('Nome da seção')).toBeNull() })
      expect(api.renameSection).toHaveBeenCalledWith('s', 'Equipe')
      await waitFor(() => { expect(slot.view.getByText('Ada')).toBeTruthy() })
      fireEvent.change(slot.view.getByLabelText('Mover Ada para seção'), { target: { value: 's' } })
      await waitFor(() => { expect(api.moveAgent).toHaveBeenCalledWith('a', 's') })
      await waitFor(() => { expect(slot.view.getByText('Nova seção').hasAttribute('disabled')).toBe(false) })
      fireEvent.click(slot.view.getByLabelText('Apagar Trabalho'))
      fireEvent.click(slot.view.getByText('Apagar seção'))
      await waitFor(() => { expect(api.deleteSection).toHaveBeenCalledWith('s') })
      await waitFor(() => { expect(slot.view.getByLabelText('Configure runtime for Ada').hasAttribute('disabled')).toBe(false) })
      fireEvent.click(slot.view.getByLabelText('Configure runtime for Ada'))
      fireEvent.submit(slot.view.getByRole('form', { name: 'Runtime' }))
      await waitFor(() => { expect(api.setRuntime).toHaveBeenCalledWith('a', 1, { runtime: 'native', runtimeModel: null, automaticFallback: false }) })
      await waitFor(() => { expect(slot.view.queryByRole('form')).toBeNull() })
      fireEvent.click(slot.view.getByLabelText('Clear runtime refusal for Ada'))
      await waitFor(() => { expect(api.clearQuota).toHaveBeenCalledWith('a') })
      await feature.dispose()
      expect(unmountRemote).toHaveBeenCalledTimes(1)
      expect(slot.container.textContent).toBe('')
      expect(runtime.ctx.resources.source('dsh-resource://agent-sidebar/0').getSnapshot().status).toBe('none')
    } finally { await runtime.dispose() }
  })
})

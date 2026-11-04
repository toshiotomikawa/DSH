// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { AgentSections, type AgentSectionsProps } from '../src/client/AgentSections.tsx'
import type { AgentSidebarSnapshot } from '../src/types.ts'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)
const data: AgentSidebarSnapshot = {
  sections: [{ id: 's', name: 'Trabalho' }],
  agents: [{ id: 'a', name: 'Ada', title: 'Developer', sectionId: 's' }, { id: 'b', name: 'Rui', title: '' }],
}

function fixture(snapshot: object = { status: 'live', value: data }) {
  const read = vi.fn(() => snapshot)
  const mutate = vi.fn<AgentSectionsProps['mutate']>().mockResolvedValue({ ok: true, value: undefined })
  const props = { wide: true, t: makeTranslate(pt), useResource: read, mutate } as unknown as AgentSectionsProps
  const view = render(<AgentSections {...props} />)
  return { read, mutate, props, ...view }
}

describe('persistent agent sections', () => {
  it('groups by stable section id, moves both ways and refreshes after successful edits', async () => {
    const f = fixture()
    expect(screen.getByRole('heading', { name: 'Trabalho' })).toBeTruthy()
    expect(screen.getByText('Ada').title).toBe('Developer')
    expect(screen.getByLabelText<HTMLSelectElement>('Mover Rui para seção').value).toBe('')
    fireEvent.change(screen.getByLabelText('Mover Ada para seção'), { target: { value: '' } })
    await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('dsh-resource://agent-sidebar/1') })
    expect(f.mutate).toHaveBeenLastCalledWith({ kind: 'move', id: 'a', sectionId: null })
    fireEvent.change(screen.getByLabelText('Mover Rui para seção'), { target: { value: 's' } })
    await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('dsh-resource://agent-sidebar/0') })
    expect(f.mutate).toHaveBeenLastCalledWith({ kind: 'move', id: 'b', sectionId: 's' })
    fireEvent.click(screen.getByText('Atualizar'))
    expect(f.read).toHaveBeenLastCalledWith('dsh-resource://agent-sidebar/1')
  })

  it('creates and renames sections with bounded, required names and cancellation', async () => {
    const f = fixture()
    fireEvent.click(screen.getByText('Nova seção'))
    const input = screen.getByLabelText('Nome da seção') as HTMLInputElement
    expect(input.required).toBe(true)
    expect(input.maxLength).toBe(40)
    expect(screen.getByText('Salvar').hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: 'Pessoal' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(screen.queryByLabelText('Nome da seção')).toBeNull() })
    expect(f.mutate).toHaveBeenLastCalledWith({ kind: 'create', name: 'Pessoal' })
    fireEvent.click(screen.getByLabelText('Renomear Trabalho'))
    fireEvent.change(screen.getByLabelText('Nome da seção'), { target: { value: 'Equipe' } })
    fireEvent.submit(screen.getByLabelText('Nome da seção').closest('form')!)
    await waitFor(() => { expect(screen.queryByLabelText('Nome da seção')).toBeNull() })
    expect(f.mutate).toHaveBeenLastCalledWith({ kind: 'rename', id: 's', name: 'Equipe' })
    fireEvent.click(screen.getByText('Nova seção'))
    fireEvent.click(screen.getByText('Cancelar'))
    expect(screen.queryByLabelText('Nome da seção')).toBeNull()
  })

  it('requires a section deletion confirmation, permits cancellation and keeps failures visible', async () => {
    const f = fixture()
    fireEvent.click(screen.getByLabelText('Apagar Trabalho'))
    fireEvent.click(screen.getByText('Cancelar'))
    expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Apagar Trabalho'))
    f.mutate.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Conflict', {}) })
    fireEvent.click(screen.getByText('Apagar seção'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Conflict') })
    expect(f.read).toHaveBeenLastCalledWith('dsh-resource://agent-sidebar/0')
    expect(screen.getByText('Apagar seção')).toBeTruthy()
    f.mutate.mockRejectedValueOnce(new Error('Offline'))
    fireEvent.click(screen.getByText('Apagar seção'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Error: Offline') })
    fireEvent.click(screen.getByText('Apagar seção'))
    await waitFor(() => { expect(screen.queryByText('Apagar seção')).toBeNull() })
    expect(f.mutate).toHaveBeenLastCalledWith({ kind: 'delete', id: 's' })
  })

  it('shows loading, failures, an empty account and no controls in the collapsed rail', () => {
    const f = fixture({ status: 'loading' })
    expect(screen.getByRole('status').textContent).toBe('Carregando agentes…')
    f.read.mockReturnValue({ status: 'failed', failure: { message: 'Unavailable' } })
    f.rerender(<AgentSections {...f.props} />)
    expect(screen.getByRole('alert').textContent).toBe('Unavailable')
    f.read.mockReturnValue({ status: 'failed' })
    f.rerender(<AgentSections {...f.props} />)
    expect(screen.getByRole('alert').textContent).toBe('')
    f.read.mockReturnValue({ status: 'live', value: { agents: [], sections: [] } })
    f.rerender(<AgentSections {...f.props} />)
    expect(screen.getByText('Nenhum agente ainda')).toBeTruthy()
    expect(screen.getByText('Sem seção')).toBeTruthy()
    f.rerender(<AgentSections {...f.props} wide={false} />)
    expect(f.container.childElementCount).toBe(0)
  })
})

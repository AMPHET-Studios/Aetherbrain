import { afterEach, describe, expect, it } from 'vitest'
import type { InterruptedStartDto } from '../src/shared/ipc'
import { SETTLE_MS, getInterrupted, interruptedMessage, rootsLabel, setInterrupted, subscribeInterrupted, vaultSentence } from '../src/renderer/startup'

const dto = (over: Partial<InterruptedStartDto> = {}): InterruptedStartDto => ({
  roots: ['D:\\', 'F:\\'],
  at: '2026-10-11T02:00:00.000Z',
  died: true,
  report: null,
  memory: '',
  vault: null,
  ...over,
})

afterEach(() => setInterrupted(null))

describe('the notice after an open that did not get through', () => {
  it('names the folders, says the window did not reopen them by itself, and offers the ways on', () => {
    const text = interruptedMessage(dto())
    expect(text).toContain('opening D:\\ + F:\\')
    expect(text).toContain('did not open them again by itself')
    expect(text).toContain('without pictures and videos')
    expect(text).toContain('other folders')
    expect(text).toContain('ran out of memory or crashed')
  })

  it('says the app was stopped when the page had not died, and carries the memory sentence, the vault numbers and the report', () => {
    const text = interruptedMessage(
      dto({ died: false, memory: "The window's page was using 3.1 GB when it was last measured (its peak 3.4 GB).", vault: { notes: 303, folders: 140000, pictures: 52000 }, report: 'C:\\x\\crash-1.json' }),
    )
    expect(text).toContain('Aether Brain was stopped while')
    expect(text).not.toContain('ran out of memory or crashed')
    expect(text).toContain('3.1 GB')
    expect(text).toContain('It held 303 notes, 140,000 folders, 52,000 pictures.')
    expect(text).toContain('A report was saved: C:\\x\\crash-1.json')
  })

  it('shortens a long list of folders and says nothing about a vault it has no numbers for', () => {
    expect(rootsLabel(['A:\\', 'B:\\', 'C:\\', 'D:\\', 'E:\\', 'F:\\'])).toBe('A:\\ + B:\\ + C:\\ + D:\\ + 2 more')
    expect(rootsLabel(['F:\\ConceptForge'])).toBe('F:\\ConceptForge')
    expect(vaultSentence(null)).toBe('')
    expect(vaultSentence({ roots: 2, picturesOff: 'no' })).toBe('')
    expect(vaultSentence({ notes: 'many' })).toBe('')
  })

  it('is a small store the shell reads and listens to', () => {
    const seen: (InterruptedStartDto | null)[] = []
    const off = subscribeInterrupted(() => seen.push(getInterrupted()))
    expect(getInterrupted()).toBeNull()
    const d = dto()
    setInterrupted(d)
    setInterrupted(null)
    off()
    setInterrupted(d)
    expect(seen).toEqual([d, null])
  })

  it('counts an open as through after a minute of the page being alive with the vault', () => {
    expect(SETTLE_MS).toBe(60_000)
  })
})

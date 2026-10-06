/**
 * RamRomInput — the DOM contract of the application's ONE RAM/ROM field.
 *
 * A change enters the field only when its value could be produced by
 * allowed typing (digits and at most one "/"); anything else — letters,
 * "GB", hyphens, spaces, a second "/" — is rejected AS ENTERED: the
 * change is refused, onChange is not called and the last accepted value
 * is restored. Nothing is ever silently rewritten ("12GB/256GB" never
 * becomes "12/256"). Deleting from a valid value always yields an
 * accepted value, so normal editing never gets stuck. These tests
 * mirror the acceptance-rule unit tests in features/validation/fields.test.ts
 * at the DOM level.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { RamRomInput } from '@/components/ui/RamRomInput'

/** Controlled harness mirroring real call sites (the value lives in the parent). */
function renderRamRom(initial = '') {
  const changes: string[] = []
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <RamRomInput
        aria-label="RAM / ROM"
        value={value}
        onChange={v => {
          changes.push(v)
          setValue(v)
        }}
      />
    )
  }
  render(<Harness />)
  return { input: screen.getByLabelText('RAM / ROM') as HTMLInputElement, changes }
}

describe('RamRomInput — accept or reject, never rewrite', () => {
  it('accepts digits and a single "/" while typing', () => {
    const { input, changes } = renderRamRom()
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.change(input, { target: { value: '12/' } })
    fireEvent.change(input, { target: { value: '12/256' } })
    expect(input.value).toBe('12/256')
    expect(changes).toEqual(['12', '12/', '12/256'])
  })

  it('keeps letters out — "12a" is refused, the field still holds "12"', () => {
    const { input, changes } = renderRamRom('12')
    fireEvent.change(input, { target: { value: '12a' } })
    expect(input.value).toBe('12')
    expect(changes).toEqual([])
  })

  it('refuses an invalid paste whole — "12GB/256GB" never becomes "12/256"', () => {
    const { input, changes } = renderRamRom('12')
    fireEvent.change(input, { target: { value: '12GB/256GB' } })
    expect(input.value).toBe('12')
    expect(changes).toEqual([])
  })

  it('refuses a second "/" and hyphenated forms', () => {
    const { input } = renderRamRom('12/256')
    fireEvent.change(input, { target: { value: '12//256' } })
    expect(input.value).toBe('12/256')
    fireEvent.change(input, { target: { value: '12-256' } })
    expect(input.value).toBe('12/256')
  })

  it('accepts a valid paste', () => {
    const { input, changes } = renderRamRom()
    fireEvent.change(input, { target: { value: '8/128' } })
    expect(input.value).toBe('8/128')
    expect(changes).toEqual(['8/128'])
  })

  it('always accepts deleting from a valid value (no stuck states)', () => {
    const { input } = renderRamRom('12/256')
    fireEvent.change(input, { target: { value: '12/25' } })
    expect(input.value).toBe('12/25')
    fireEvent.change(input, { target: { value: '12/' } })
    expect(input.value).toBe('12/')
    fireEvent.change(input, { target: { value: '12' } })
    expect(input.value).toBe('12')
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })

  it('a malformed value (isolated test input) cannot be edited per-keystroke — it is rejected as entered, but can always be cleared wholesale', () => {
    // No stored value can look like this anymore (the database enforces
    // N/M); this exercises the contract defensively with direct input.
    const { input, changes } = renderRamRom('12GB/256GB')
    fireEvent.change(input, { target: { value: '12GB/256G' } })
    expect(input.value).toBe('12GB/256GB')
    expect(changes).toEqual([])
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    expect(changes).toEqual([''])
  })
})

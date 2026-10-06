/**
 * Field validation unit tests — every example from the FUSION ONE
 * validation specification, plus the DB-mirror semantics (migration 0012
 * enforces the same rules server-side; the DB integration suite proves
 * that side — this file proves the shared frontend contract).
 */
import { describe, expect, it } from 'vitest'
import {
  acceptsRamRomInput,
  filterImeiInput,
  formatMoney,
  formatPhoneDisplay,
  imeiProgress,
  isValidImei,
  isValidRamRom,
  normalizePhoneIN,
  normalizeRamRom,
  normalizeSearchText,
  normalizeGstin,
  parseMoney,
  softNormalizePhone,
  validateEmail,
  validateGstin,
  validateImei,
  validatePhoneIN,
  validateRamRom,
  validateTradeInDevice,
  validateTradeInDeviceFields,
} from './fields'

describe('IMEI — strict 15-digit invariant', () => {
  it('accepts the canonical form', () => {
    expect(isValidImei('123456789012345')).toBe(true)
    expect(validateImei('123456789012345')).toBeNull()
  })

  it('rejects every malformed form from the spec', () => {
    const invalid = [
      '12345678901234',            // 14 digits
      '1234567890123456',          // 16 digits
      '12345 6789012345',          // spaces
      '12345-6789012345',          // hyphens
      '+911234567890123',          // leading +
      'abc123456789012',           // letters
      '1234567890123a5',           // a letter inside
      '123456789012_45',           // underscore
      '',                          // empty
      '   ',                       // whitespace only
    ]
    for (const v of invalid) {
      expect(isValidImei(v,)).toBe(false)
      expect(validateImei(v)).not.toBeNull()
    }
  })

  it('trims surrounding whitespace before validating', () => {
    expect(isValidImei('  123456789012345  ')).toBe(true)
  })

  it('does NOT enforce Luhn (legitimate business data contains non-Luhn device IDs)', () => {
    // 15 digits, fails Luhn — still valid per the FUSION ONE contract.
    expect(isValidImei('912345678901234')).toBe(true)
    expect(isValidImei('987654321098765')).toBe(true)
  })
})

describe('RAM/ROM — N/M device specification format', () => {
  it('accepts the canonical forms from the spec', () => {
    for (const v of ['4/64', '6/128', '8/256', '12/256', '16/512']) {
      expect(isValidRamRom(v)).toBe(true)
      expect(validateRamRom(v)).toBeNull()
    }
  })

  it('rejects every malformed form from the spec', () => {
    const invalid = [
      '12 GB/256 GB',
      '12 / 256',
      '12-256',
      '12\\256',
      '12/256GB',
      '/256',
      '12/',
      'abc/256',
      '12//256',
      '',
    ]
    for (const v of invalid) {
      expect(isValidRamRom(v)).toBe(false)
      expect(validateRamRom(v)).not.toBeNull()
    }
  })

  it('trims entry noise but preserves the canonical value', () => {
    expect(normalizeRamRom('  8/128  ')).toBe('8/128')
    expect(normalizeRamRom('12/256')).toBe('12/256')
  })
})

describe('Indian phone canonicalization → +91XXXXXXXXXX', () => {
  it('normalizes every supported input form to the same canonical value', () => {
    const canonical = '+919876543210'
    for (const input of [
      '9876543210',
      '919876543210',
      '+919876543210',
      '91 9876543210',
      '+91 9876543210',
      '+91 98765 43210',
      '98765 43210',
    ]) {
      expect(normalizePhoneIN(input), `input "${input}"`).toBe(canonical)
    }
  })

  it('returns null for unsupported / malformed numbers', () => {
    for (const input of [
      '+1 555 1234',       // non-Indian
      'abcdefghij',        // letters
      '12345',             // too short
      '09876543210',       // 11 digits with trunk 0
      '987654321123456',   // too long
      '910123456789',      // 91 + non-mobile (3rd digit 0)
      '0123456789',        // does not start 6-9
      '',                  // empty
    ]) {
      expect(normalizePhoneIN(input), `input "${input}"`).toBeNull()
    }
  })

  it('validatePhoneIN requires a normalizable number', () => {
    expect(validatePhoneIN('9876543210')).toBeNull()
    expect(validatePhoneIN('+91 98765 43210')).toBeNull()
    expect(validatePhoneIN('')).not.toBeNull()
    expect(validatePhoneIN('+1 555 1234')).not.toBeNull()
  })

  it('softNormalizePhone keeps unrecognized values verbatim (store display field)', () => {
    expect(softNormalizePhone('9876543210')).toBe('+919876543210')
    expect(softNormalizePhone('0551 223 3445')).toBe('0551 223 3445')  // landline kept
    expect(softNormalizePhone('  ')).toBe('')
  })

  it('formatPhoneDisplay renders the canonical form readably', () => {
    expect(formatPhoneDisplay('+919876543210')).toBe('+91 98765 43210')
    expect(formatPhoneDisplay('0551 223 3445')).toBe('0551 223 3445') // non-canonical kept as-is
    expect(formatPhoneDisplay(null)).toBe('')
  })
})

describe('parseMoney — strict numeric semantics', () => {
  it('parses well-formed amounts', () => {
    expect(parseMoney('0')).toBe(0)
    expect(parseMoney('1250')).toBe(1250)
    expect(parseMoney('1250.50')).toBe(1250.5)
    expect(parseMoney(' 999.99 ')).toBe(999.99)
  })

  it('rejects malformed input instead of coercing it', () => {
    const bad: Array<string | undefined> = ['', '  ', 'abc', '12a', '1.2.3', 'NaN', undefined]
    for (const v of bad) {
      expect(parseMoney(v), `input "${v}"`).toBeNull()
    }
  })

  it('enforces min / max / integer options', () => {
    expect(parseMoney('-5')).toBeNull()                 // default min 0
    expect(parseMoney('-5', { min: -10 })).toBe(-5)
    expect(parseMoney('5000', { max: 1000 })).toBeNull()
    expect(parseMoney('2.5', { integer: true })).toBeNull()
    expect(parseMoney('3', { integer: true })).toBe(3)
    expect(parseMoney('0')).toBe(0)                     // zero allowed (₹0 invoices are valid)
  })

  it('formatMoney formats en-IN with sign preserved', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50')
    expect(formatMoney(-500)).toBe('-500.00')           // never Math.abs
    expect(formatMoney(0)).toBe('0.00')
    expect(formatMoney(null)).toBe('—')
  })
})

describe('GSTIN & email', () => {
  it('validates GSTIN shape (optional field)', () => {
    expect(validateGstin('')).toBeNull()
    expect(validateGstin('09ABCDE1234F1Z5')).toBeNull()
    expect(validateGstin(' 09abcde1234f1z5 ')).toBeNull()  // normalized before checking
    expect(normalizeGstin(' 09abcde1234f1z5 ')).toBe('09ABCDE1234F1Z5')
    expect(validateGstin('123')).not.toBeNull()
    expect(validateGstin('09ABCDE1234F1Z')).not.toBeNull()
  })

  it('validates email shape (optional field)', () => {
    expect(validateEmail('')).toBeNull()
    expect(validateEmail('hello@fusiongadgets.in')).toBeNull()
    expect(validateEmail('not-an-email')).not.toBeNull()
    expect(validateEmail('a@b')).not.toBeNull()
  })
})

describe('normalizeSearchText — retrieval normalization (mirrors private.search_norm)', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeSearchText('OnePlus 12R')).toBe('oneplus12r')
    expect(normalizeSearchText('one plus 12r')).toBe('oneplus12r')
    expect(normalizeSearchText('iPhone 15')).toBe('iphone15')
    expect(normalizeSearchText('i phone 15')).toBe('iphone15')
    expect(normalizeSearchText('12/256')).toBe('12256')
    expect(normalizeSearchText('  SAMSUNG  ')).toBe('samsung')
  })
})

describe('validateTradeInDevice — the ONE shared trade-in validator', () => {
  const valid = {
    brand: 'Samsung', model: 'Galaxy S12', imei: '912345678901234',
    ram_rom: '8/128', color: 'Black', credit_value: '3000', mrp: '5000',
  }

  it('accepts a complete, valid device', () => {
    expect(validateTradeInDevice(valid)).toBeNull()
    expect(validateTradeInDevice({ ...valid, mrp: '' })).toBeNull() // MRP optional
  })

  it('rejects each missing identity field', () => {
    expect(validateTradeInDevice({ ...valid, brand: ' ' })).toBe('Brand is required.')
    expect(validateTradeInDevice({ ...valid, model: '' })).toBe('Model is required.')
    expect(validateTradeInDevice({ ...valid, color: '' })).toBe('Color is required.')
  })

  it('rejects invalid IMEI and RAM/ROM with the canonical messages', () => {
    expect(validateTradeInDevice({ ...valid, imei: '12345' })).toContain('15 digits')
    expect(validateTradeInDevice({ ...valid, ram_rom: '8 GB / 128 GB' })).toContain('12/256')
  })

  it('rejects invalid money values', () => {
    expect(validateTradeInDevice({ ...valid, credit_value: '' })).toBe('Enter a valid credit value.')
    expect(validateTradeInDevice({ ...valid, credit_value: '-1' })).toBe('Enter a valid credit value.')
    expect(validateTradeInDevice({ ...valid, mrp: 'abc' })).toBe('Enter a valid MRP.')
  })

  it('reports every field error at once via the per-field map', () => {
    const errors = validateTradeInDeviceFields({ ...valid, brand: '', imei: '123', credit_value: '' })
    expect(errors.brand).toBe('Brand is required.')
    expect(errors.imei).toBe('IMEI must be 15 digits.')
    expect(errors.credit_value).toBe('Enter a valid credit value.')
    expect(errors.model).toBeNull()
  })
})

describe('IMEI input-time constraints (ImeiInput keystroke/paste filter)', () => {
  it('keeps digits only — letters, spaces, +, hyphens and symbols never enter', () => {
    expect(filterImeiInput('12897abc')).toBe('12897')
    expect(filterImeiInput('12345 6789012345')).toBe('123456789012345')
    expect(filterImeiInput('+911234567890123')).toBe('911234567890123')
    expect(filterImeiInput('12345-678901234')).toBe('12345678901234')
    expect(filterImeiInput('abc')).toBe('')
  })

  it('caps the value at 15 digits — the 16th digit never enters', () => {
    expect(filterImeiInput('1234567890123456')).toBe('123456789012345')
    expect(filterImeiInput('123456789012345abcdef')).toBe('123456789012345')
  })

  it('never produces a value the canonical validator would reject as malformed', () => {
    for (const raw of ['12897abc', '12 34-56+78 90 12 34 5x', '  123456789012345  ']) {
      const filtered = filterImeiInput(raw)
      expect(filtered).toBe(filtered.replace(/\D/g, ''))
      expect(filtered.length).toBeLessThanOrEqual(15)
    }
  })
})

describe('IMEI completion feedback', () => {
  it('shows "N / 15 digits" while incomplete and non-empty', () => {
    expect(imeiProgress('123')).toBe('3 / 15 digits')
    expect(imeiProgress('12345678901234')).toBe('14 / 15 digits')
  })

  it('is quiet once complete or empty', () => {
    expect(imeiProgress('')).toBeNull()
    expect(imeiProgress('123456789012345')).toBeNull()
  })
})

describe('RAM/ROM input-time constraints (RamRomInput accept-or-reject rule)', () => {
  it('accepts every value allowed typing can produce', () => {
    for (const v of ['', '12', '12/', '12/2', '12/256', '8/128', '4/64']) {
      expect(acceptsRamRomInput(v), `value "${v}"`).toBe(true)
    }
  })

  it('rejects values allowed typing can never produce — nothing is stripped to manufacture a valid one', () => {
    for (const v of ['12a/256', '12-256', '12//256', '12 / 256', '12GB/256GB', '12/256GB', 'abc', '12GB/256G']) {
      expect(acceptsRamRomInput(v), `value "${v}"`).toBe(false)
    }
  })

  it('never turns "12GB/256GB" into "12/256" — the verdict is reject, not rewrite', () => {
    expect(acceptsRamRomInput('12GB/256GB')).toBe(false)
    expect(acceptsRamRomInput('12a/256')).toBe(false)
  })

  it('allows the incomplete "12/" while typing — blur/submit judges it', () => {
    expect(acceptsRamRomInput('12/')).toBe(true)
    expect(validateRamRom('12/')).toBe('Enter RAM and storage like 12/256.')
  })

  it('deleting from a valid value always yields an accepted value (no stuck states)', () => {
    // Every prefix/deletion of a canonical stored value is typing-producible.
    expect(acceptsRamRomInput('12/25')).toBe(true)
    expect(acceptsRamRomInput('12/')).toBe(true)
    expect(acceptsRamRomInput('12')).toBe(true)
    expect(acceptsRamRomInput('1')).toBe(true)
    expect(acceptsRamRomInput('')).toBe(true)
    expect(acceptsRamRomInput('8/128')).toBe(true)
  })
})

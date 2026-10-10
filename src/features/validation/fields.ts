/**
 * FUSION ONE — canonical field validation & normalization (the ONE shared
 * boundary for structured field rules).
 *
 * Mirrors the database contracts enforced by migration 0012 so the
 * frontend gives immediate feedback with EXACTLY the same semantics the
 * database will enforce:
 *
 *   IMEI     exactly 15 digits — no spaces, +, hyphens or letters
 *            (rejected, never silently stripped-and-accepted; Luhn is
 *            deliberately NOT enforced — the existing business data
 *            contains legitimate non-Luhn device IDs). IMEI inputs also
 *            PREVENT impossible characters as the user types
 *            (filterImeiInput) — the filter and the validator are one
 *            contract, defined here together.
 *   RAM/ROM  "RAM/ROM" with numeric components, exactly one "/" —
 *            8/128, 12/256 valid; "12 GB/256 GB", "12 / 256" invalid.
 *            acceptsRamRomInput is the entry rule RamRomInput accepts or
 *            rejects each change against: only values typing digits and
 *            a single "/" can produce ever enter the field — invalid
 *            input is rejected as entered, never silently rewritten
 *            ("12GB/256GB" never becomes "12/256").
 *   Phone    Indian mobile canonicalization to +91XXXXXXXXXX
 *            (10-digit, 91-prefixed and +91-prefixed inputs, spaced
 *            variants included). Parties store the canonical form
 *            (strictly validated); the store display field soft-normalizes.
 *   Money    strict parse for form strings (MoneyInput already sanitizes
 *            keystrokes; this is the save-time contract).
 *
 * MESSAGES are plain business language — never regex/constraint/RPC
 * terminology. They are the user-facing text shown next to fields.
 *
 * RULES OF USE:
 *   - Components import validators from HERE; never re-declare a regex.
 *   - One semantic rule = one implementation, mirrored once in the DB.
 */

// ─── IMEI ───────────────────────────────────────────────────────────────────

export const IMEI_LENGTH = 15

/** Exactly 15 digits, nothing else. */
export function isValidImei(value: string): boolean {
  return /^\d{15}$/.test(value.trim())
}

/** Error message for an invalid IMEI, or null when valid. */
export function validateImei(value: string): string | null {
  if (!value.trim()) return 'IMEI is required.'
  return isValidImei(value) ? null : 'IMEI must be 15 digits.'
}

/**
 * Input-time constraint for IMEI fields: keep digits only, cap at 15.
 * Applied on every keystroke/paste so impossible characters never enter
 * the field ("12897abc" stays "12897") — same contract as validateImei.
 */
export function filterImeiInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, IMEI_LENGTH)
}

/**
 * Subtle completion feedback for an IMEI being typed: "13 / 15 digits"
 * while incomplete and non-empty, null once complete (or empty).
 */
export function imeiProgress(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  if (!digits || digits.length >= IMEI_LENGTH) return null
  return `${digits.length} / 15 digits`
}

// ─── RAM / ROM ──────────────────────────────────────────────────────────────

/**
 * "RAM/ROM" with numeric components and exactly one slash — the device
 * specification format: 4/64, 6/128, 8/256, 12/256, 16/512.
 */
export function isValidRamRom(value: string): boolean {
  return /^\d+\/\d+$/.test(value.trim())
}

/** Error message for malformed RAM/ROM, or null when valid. */
export function validateRamRom(value: string): string | null {
  if (!value.trim()) return 'RAM/ROM is required.'
  return isValidRamRom(value) ? null : 'Enter RAM and storage like 12/256.'
}

/**
 * Input-time acceptance rule for RAM/ROM fields (used by RamRomInput):
 * accept a change only when its value could be produced by allowed
 * typing — digits and at most one "/" ("", "12", "12/", "12/256").
 * Substantially invalid input such as "12GB/256GB" is therefore rejected
 * AS ENTERED, never silently rewritten into "12/256". An incomplete "12/"
 * is allowed while typing (a natural intermediate state) and is judged by
 * validateRamRom on blur/submit. Every value that can legitimately be in
 * the field — a canonical stored "N/M" or any prefix of it being edited —
 * satisfies the rule, so normal typing and deleting always work. Same
 * contract as validateRamRom.
 */
export function acceptsRamRomInput(next: string): boolean {
  return next === '' || /^\d*\/?\d*$/.test(next)
}

/** Leading/trailing whitespace is entry noise, not data: trim it. */
export function normalizeRamRom(value: string): string {
  return value.trim()
}

// ─── Indian phone numbers ───────────────────────────────────────────────────

/**
 * Canonicalize a supported Indian mobile input to +91XXXXXXXXXX.
 * Returns null when the input is not a recognizable Indian mobile form
 * (the caller decides whether null means "reject" or "leave as typed").
 *
 *   9876543210        → +919876543210
 *   919876543210      → +919876543210
 *   +919876543210     → +919876543210
 *   91 9876543210     → +919876543210
 *   +91 98765 43210   → +919876543210
 */
export function normalizePhoneIN(value: string): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`
  return null
}

/** Error message for an unnormalizable non-empty number, or null when OK. */
export function validatePhoneIN(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Phone number is required.'
  return normalizePhoneIN(trimmed) ? null : 'Enter a valid 10-digit Indian mobile number.'
}

/**
 * Soft canonicalization for DISPLAY/contact fields (the store's own
 * number): canonicalize recognizable Indian mobile forms, keep anything
 * else verbatim (a landline is legitimate there).
 */
export function softNormalizePhone(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return normalizePhoneIN(trimmed) ?? trimmed
}

/** Human-friendly display: +919876543210 → "+91 98765 43210". */
export function formatPhoneDisplay(value: string | null | undefined): string {
  if (!value) return ''
  const canonical = normalizePhoneIN(value)
  if (canonical) return `${canonical.slice(0, 3)} ${canonical.slice(3, 8)} ${canonical.slice(8)}`
  return value
}

// ─── Money (form strings → numbers) ────────────────────────────────────────

export interface MoneyOptions {
  /** Minimum allowed value (default 0 — business amounts are non-negative). */
  min?: number
  /** Maximum allowed value, when the business context caps it. */
  max?: number
  /** Require a whole number (quantities, counters). */
  integer?: boolean
}

/**
 * STRICT money/number parse for save paths: a MoneyInput string must be a
 * well-formed number (never a silent NaN/0 from malformed input).
 * Returns the parsed number, or null when invalid.
 */
export function parseMoney(value: string | null | undefined, opts: MoneyOptions = {}): number | null {
  const { min = 0, max, integer = false } = opts
  const trimmed = (value ?? '').trim()
  if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  if (integer && !Number.isInteger(n)) return null
  if (n < min) return null
  if (max !== undefined && n > max) return null
  return n
}

/** The ONE money formatter (en-IN, 2 decimals, sign preserved). */
export function formatMoney(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (n === null || n === undefined || !Number.isFinite(n as number)) return '—'
  return (n as number).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Identifiers & contact ─────────────────────────────────────────────────

/** GSTIN: 15 chars — 2-digit state code, PAN, entity code, 'Z', checksum. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/

/** Trim + uppercase is the canonical storage form. */
export function normalizeGstin(value: string): string {
  return value.trim().toUpperCase()
}

/** Optional-field validator: empty is allowed, non-empty must conform. */
export function validateGstin(value: string): string | null {
  const canonical = normalizeGstin(value)
  if (!canonical) return null
  return GSTIN_PATTERN.test(canonical) ? null : 'Enter a valid 15-character GSTIN (e.g. 09ABCDE1234F1Z5)'
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Optional-field validator: empty is allowed, non-empty must be an email. */
export function validateEmail(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return EMAIL_PATTERN.test(trimmed) ? null : 'Enter a valid email address'
}

// ─── Search text normalization (mirrors private.search_norm in SQL) ────────

/**
 * Retrieval normalization shared by search UIs: lowercase + strip every
 * non-alphanumeric character. "one plus 12r" → "oneplus12r", "12/256" →
 * "12256". Mirrors private.search_norm() in migration 0012 — the RPC does
 * the authoritative ranking; this exists so client-side previews, tests
 * and future callers agree on what "normalized" means.
 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ─── Trade-in device form (shared by the sale editor + conversion dialog) ──

export interface TradeInDeviceFields {
  brand: string
  model: string
  imei: string
  ram_rom: string
  color: string
  credit_value: string
  mrp: string
}

/** Per-field trade-in errors (null = that field is fine). */
export interface TradeInDeviceErrors {
  brand: string | null
  model: string | null
  imei: string | null
  ram_rom: string | null
  color: string | null
  credit_value: string | null
  mrp: string | null
}

/**
 * The ONE trade-in device validator, per field (same fields in the New
 * Sale modal and the Convert Proforma dialog): identity required + strict
 * IMEI + RAM/ROM format + non-negative money. Optional MRP must parse
 * when present. Inline field errors render each entry next to its field.
 */
export function validateTradeInDeviceFields(d: TradeInDeviceFields): TradeInDeviceErrors {
  return {
    brand: d.brand.trim() ? null : 'Brand is required.',
    model: d.model.trim() ? null : 'Model is required.',
    imei: validateImei(d.imei),
    ram_rom: validateRamRom(d.ram_rom),
    color: d.color.trim() ? null : 'Color is required.',
    credit_value: parseMoney(d.credit_value) === null ? 'Enter a valid credit value.' : null,
    mrp: d.mrp.trim() !== '' && parseMoney(d.mrp) === null ? 'Enter a valid MRP.' : null,
  }
}

/**
 * The ONE trade-in device check as a single first-error message (null when
 * valid) — derived from the per-field map so there is exactly one
 * implementation of the rules.
 */
export function validateTradeInDevice(d: TradeInDeviceFields): string | null {
  const errors = validateTradeInDeviceFields(d)
  return errors.brand ?? errors.model ?? errors.imei ?? errors.ram_rom
    ?? errors.color ?? errors.credit_value ?? errors.mrp
}

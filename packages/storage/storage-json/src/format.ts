/**
 * On-disk JSON unit format: the file is always the current net state, kept
 * human-readable (pretty-printed, stable key order from insertion) — that
 * legibility is this backend's reason to exist. `single`-layout units are
 * one document with a unit header; `per-record`-layout units are a directory
 * with one version-stamped document per record (`<table>/<key>.json`) plus a
 * `global.json` for the global slot, so a write rewrites one record instead
 * of the whole unit.
 * @module @deepseek-ai/dsh-storage-json/src/format
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** In-memory authoritative state of one unit; the file is its projection. `global` is `null` until first written. */
export interface UnitState {
  version: number
  global: unknown
  tables: Map<string, Map<string, unknown>>
}

/**
 * Serialize a unit state to file content.
 * @param name - Unit name, stamped into the header.
 * @param state - Authoritative in-memory state.
 * @returns pretty-printed JSON document with a trailing newline.
 */
export function serialize(name: string, state: UnitState): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: { name, version: state.version },
    global: state.global,
    tables,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Parse file content into unit state, validating shape and version.
 * @param text - Raw file content.
 * @param descriptor - Expected identity and accepted current or compatible versions.
 * @returns the parsed state.
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not a JSON object`)
  }
  const { unit, global: globalValue, tables } = document as Record<string, unknown>
  if (
    typeof unit !== 'object' || unit === null ||
    (unit as Record<string, unknown>)['name'] !== descriptor.name ||
    typeof (unit as Record<string, unknown>)['version'] !== 'number'
  ) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  const version = (unit as Record<string, unknown>)['version'] as number
  if (version !== descriptor.version && !descriptor.compatibleVersions?.includes(version)) {
    throw new StorageError(
      'version-mismatch',
      `unit '${descriptor.name}': stored version ${version} is not accepted by version ${descriptor.version}`,
    )
  }
  // `typeof` alone admits an array: reading one as a table map reports every
  // declared table as absent, and the next publish replaces the file with that
  // empty view, discarding records this reader could not see.
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': tables is not an object`)
  }
  const state: UnitState = { version, global: globalValue ?? null, tables: new Map() }
  for (const table of descriptor.tables) {
    const records = (tables as Record<string, unknown>)[table]
    if (records === undefined) {
      state.tables.set(table, new Map())
      continue
    }
    if (typeof records !== 'object' || records === null || Array.isArray(records)) {
      throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
    }
    state.tables.set(table, new Map(Object.entries(records as Record<string, unknown>)))
  }
  return state
}

/**
 * Serialize one per-record document: the unit's version stamp plus the
 * record value, pretty-printed like the whole-unit document.
 * @param version - Unit format version, stamped into the header.
 * @param value - The record value (or the global singleton value).
 * @returns pretty-printed JSON document with a trailing newline.
 */
export function serializeRecord(version: number, value: unknown): string {
  return `${JSON.stringify({ version, record: value }, null, 2)}\n`
}

/**
 * Outcome of reading one per-record document. `damaged` is a document that
 * exists but is not a record envelope this reader understands (bad JSON, not
 * an object, or no numeric version stamp): the caller decides whether that is
 * disposable or authoritative data. `foreign` is a well-formed envelope
 * stamped with an unaccepted version, which the per-record contract discards
 * instead of migrating.
 */
export type RecordRead =
  | { readonly kind: 'record'; readonly value: unknown }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'foreign' }

/**
 * Read one per-record document and keep the reason it was not a record. A
 * `foreign` stamp reads as absent — one stale record file must not brick the
 * whole unit, and migrating records the owner never vouched for would restamp
 * them as current (the whole-unit format rejects instead, because there is
 * exactly one document). A `damaged` document is reported so an authoritative
 * domain can quarantine it rather than mistake corruption for absence.
 * @param text - Raw per-record document content.
 * @param versions - Accepted unit versions (the current one plus the
 * descriptor's compatibleVersions).
 * @returns the record value, or why the document was not read as one.
 */
export function readRecordDocument(text: string, versions: readonly number[]): RecordRead {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { kind: 'damaged' }
  }
  if (typeof document !== 'object' || document === null) return { kind: 'damaged' }
  const { version: stamped, record } = document as Record<string, unknown>
  if (typeof stamped !== 'number') return { kind: 'damaged' }
  if (!versions.includes(stamped)) return { kind: 'foreign' }
  if (!('record' in document)) return { kind: 'damaged' }
  return { kind: 'record', value: record }
}

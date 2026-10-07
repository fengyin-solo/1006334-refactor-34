import { migrateLegacy } from '@/domain/entry-approval'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
// 存储结构升到 v2：v1 是平铺的模块字典，v2 带版本号，首读时做存量回填迁移。
const STORAGE_VERSION = 2

type StorePayload = { version: number; rows: Record<string, EntryRow[]> }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withMigration(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const migrated = migrateLegacy(rows.entryapprove ?? [], rows.maintenance ?? [])
  return {
    ...rows,
    entryapprove: migrated.entryRows,
    maintenance: migrated.maintRows,
  }
}

function seedPayload(): StorePayload {
  return { version: STORAGE_VERSION, rows: withMigration(clone(SEED_ROWS)) }
}

function persist(payload: StorePayload): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }
}

function readStorage(): StorePayload {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedPayload()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const payload = seedPayload()
    persist(payload)
    return payload
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StorePayload> & Record<string, unknown>
    // v2 带 version；v1 是直接平铺的模块字典（没有 version 字段）。
    const legacyRows =
      typeof parsed.version === 'number'
        ? (parsed.rows as Record<string, EntryRow[]>)
        : (parsed as unknown as Record<string, EntryRow[]>)
    // 旧版本可能缺新模块：用示例数据补齐，再统一做一次存量回填迁移后升级。
    const merged: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...clone(legacyRows) }
    const payload: StorePayload = { version: STORAGE_VERSION, rows: withMigration(merged) }
    persist(payload)
    return payload
  } catch {
    const payload = seedPayload()
    persist(payload)
    return payload
  }
}

let cache: StorePayload | null = null

function store(): StorePayload {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return store().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const payload = store()
  const next: StorePayload = { ...payload, rows: { ...payload.rows, [key]: rows } }
  cache = next
  persist(next)
}

/** 一次事务写回多个模块（申请与维保台账同生共改，待办读数才不会错位）。 */
export function saveAll(patches: Record<string, EntryRow[]>): void {
  const payload = store()
  const next: StorePayload = { ...payload, rows: { ...payload.rows, ...patches } }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  return resetKeys([key])[key]
}

/** 多个模块一起回到示例数据，再统一迁移一次，保证跨模块关联一次性补齐。 */
export function resetKeys(keys: string[]): Record<string, EntryRow[]> {
  const seeded = { ...store().rows }
  for (const key of keys) {
    seeded[key] = clone(SEED_ROWS[key] ?? [])
  }
  const migrated = withMigration(seeded)
  saveAll(migrated)
  return Object.fromEntries(keys.map((key) => [key, migrated[key]]))
}

export function storageKey(): string {
  return STORAGE_KEY
}

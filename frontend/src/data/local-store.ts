import { runMigration, MIGRATION_KEY, MIGRATION_VERSION } from '@/domain/migration'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function persist(data: Record<string, EntryRow[]>, version: number | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  if (version !== null) {
    window.localStorage.setItem(MIGRATION_KEY, String(version))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return runMigration(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    // 首次打开：播种后立即走一遍存量回填，版本落盘，只跑这一次。
    const seeded = runMigration(fallback)
    persist(seeded, MIGRATION_VERSION)
    return seeded
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = { ...fallback, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
  } catch {
    const seeded = runMigration(fallback)
    persist(seeded, MIGRATION_VERSION)
    return seeded
  }

  // 版本化迁移：新版本首次读到旧数据时按新规则再补一次（只补不删，历史记录不改写）。
  const doneVersion = Number(window.localStorage.getItem(MIGRATION_KEY) ?? '0') || 0
  if (doneVersion < MIGRATION_VERSION) {
    const migrated = runMigration(parsed)
    persist(migrated, MIGRATION_VERSION)
    return migrated
  }
  return parsed
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAll({ [key]: rows })
}

/**
 * 多模块一次落库：审批结论与维保台账在同一事务里提交。
 * 纯前端没有数据库事务，这里以「一次写入同一存储键、同一缓存赋值」实现原子边界：
 * 两个模块要么同时生效、要么都不动，待办清单与台账读数因此始终一致。
 */
export function saveAll(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  // 重置后仍走一遍回填迁移（单模块重置会牵动申请↔台账联批关系），
  // 保证重置出的示例数据与首次播种时口径一致。
  const merged = { ...allRows(), [key]: clone(SEED_ROWS[key] ?? []) }
  const migrated = runMigration(merged)
  cache = migrated
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
  }
  return migrated[key] ?? []
}

export function storageKey(): string {
  return STORAGE_KEY
}

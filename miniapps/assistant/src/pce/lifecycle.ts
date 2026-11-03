/**
 * @fileoverview Consent and retention for every copy, not just the memory row. ANI-212.
 *
 * Revoking a scope used to mean `memory.deleteScope`. But a capture leaves
 * derivatives everywhere — the image, its OCR, an embedding, a summary, a
 * cached context bundle, a queued upload, a backup. A revocation that deletes
 * the memory and leaves the OCR is not a revocation.
 *
 * So every store holding consent-governed data registers here, with a
 * category from the inventory below, and three things follow:
 *
 *   WRITES ARE CHECKED AT THE BOUNDARY. `admit(meta)` refuses a record with
 *   no scope, purpose, expiry, provenance or owner, or whose scope is revoked
 *   or expired. Stores call it on write, so policy does not depend on each
 *   caller remembering.
 *
 *   REVOCATION REACHES EVERY STORE, AND PROVES IT. The policy ledger records
 *   the revocation first (terminal, and it wins over anything arriving later),
 *   then each store purges, then each is asked to COUNT what is left. The
 *   receipt reports per store: deleted, remaining, and any failure. A store
 *   that is unreachable (the glasses are off, the on-prem server is down) is
 *   marked pending and retried until it converges.
 *
 *   THE INVENTORY HAS NO GAPS. `gaps()` lists categories with no registered
 *   store. A category nobody registered is a category nobody purges.
 *
 * Consent retention is not legal retention. A store can declare a legal hold
 * category, which is reported in the receipt as held rather than silently
 * kept; what qualifies is counsel's call, not this file's.
 */

import type {PolicyEngine, Purpose} from "./policy"

/** Every kind of personal data and derivative the ecosystem keeps. */
export const INVENTORY = [
  "capture_media",
  "transcripts",
  "ocr",
  "embeddings",
  "summaries",
  "context_snapshots",
  "memories",
  "tool_caches",
  "event_queues",
  "local_backups",
  "analytics",
  "training_datasets",
] as const
export type StoreCategory = (typeof INVENTORY)[number]

export interface GovernedMeta {
  scopeId: string
  purpose: Purpose
  expiresAt: number
  provenance: "captured" | "derived" | "sensor"
  ownerUserId: string
  tenantId?: string
  /** For a derivative: the record it was made from. */
  sourceId?: string
}

export interface GovernedStore {
  name: string
  category: StoreCategory
  /** Where it lives, for propagation: on the phone, on a device, or remote. */
  location: "phone" | "glasses" | "ring" | "site" | "cloud"
  purge(scopeId: string): Promise<number>
  /** What is left for the scope. Zero after a complete purge. */
  count(scopeId: string): Promise<number>
  /** Records kept under a legal hold despite revocation. Reported, never hidden. */
  legalHold?(scopeId: string): Promise<number>
}

export interface StoreReceipt {
  store: string
  category: StoreCategory
  status: "complete" | "incomplete" | "pending" | "failed"
  deleted: number
  remaining: number
  held: number
  error?: string
}

export interface ErasureReceipt {
  scopeId: string
  at: number
  complete: boolean
  stores: StoreReceipt[]
}

export type AdmitResult = {ok: true} | {ok: false; reason: "missing_metadata" | "scope_revoked" | "expired" | "purpose_not_granted"}

export class DataLifecycle {
  private stores: GovernedStore[] = []
  /** Revocations still to reach some store, by scope. */
  private pending = new Map<string, Set<string>>()

  constructor(private readonly deps: {policy: PolicyEngine; now: () => number; reachable: (location: GovernedStore["location"]) => boolean}) {}

  register(store: GovernedStore): void {
    if (this.stores.some(s => s.name === store.name)) throw new Error(`Store ${store.name} registered twice`)
    this.stores.push(store)
  }

  inventory(): {name: string; category: StoreCategory; location: GovernedStore["location"]}[] {
    return this.stores.map(s => ({name: s.name, category: s.category, location: s.location}))
  }

  /** Categories nothing is registered for. Each one is data nobody would purge. */
  gaps(): StoreCategory[] {
    return INVENTORY.filter(c => !this.stores.some(s => s.category === c))
  }

  /** The write-path check, for stores to call on every governed write. */
  admit(meta: Partial<GovernedMeta> | undefined): AdmitResult {
    if (!meta || !meta.scopeId || !meta.purpose || !meta.provenance || !meta.ownerUserId || typeof meta.expiresAt !== "number") {
      return {ok: false, reason: "missing_metadata"}
    }
    if (this.deps.policy.isRevoked(meta.scopeId)) return {ok: false, reason: "scope_revoked"}
    if (meta.expiresAt <= this.deps.now()) return {ok: false, reason: "expired"}
    if (this.deps.policy.forPurpose(meta.purpose).reach(meta.scopeId) === null) return {ok: false, reason: "purpose_not_granted"}
    return {ok: true}
  }

  /**
   * Revoke a scope everywhere. The policy event is applied first, so nothing
   * new can be admitted while the purge runs.
   */
  async revoke(scopeId: string, revocation: Parameters<PolicyEngine["apply"]>[0]): Promise<ErasureReceipt> {
    if (revocation.kind !== "revoke" || revocation.scopeId !== scopeId) throw new Error("Not a revocation for this scope")
    this.deps.policy.apply(revocation)
    if (!this.deps.policy.isRevoked(scopeId)) throw new Error("The revocation was not accepted by policy; nothing purged")
    this.pending.set(scopeId, new Set(this.stores.map(s => s.name)))
    return this.propagate(scopeId)
  }

  /** Retry stores the revocation has not reached yet. Call on reconnect. */
  async converge(): Promise<ErasureReceipt[]> {
    const out: ErasureReceipt[] = []
    for (const scopeId of [...this.pending.keys()]) out.push(await this.propagate(scopeId))
    return out
  }

  /** Scopes whose revocation has not yet reached every store. */
  unconverged(): string[] {
    return [...this.pending.keys()].sort()
  }

  private async propagate(scopeId: string): Promise<ErasureReceipt> {
    const todo = this.pending.get(scopeId) ?? new Set<string>()
    const receipts: StoreReceipt[] = []
    for (const s of this.stores) {
      if (!todo.has(s.name)) continue
      const base = {store: s.name, category: s.category, deleted: 0, remaining: 0, held: 0}
      if (!this.deps.reachable(s.location)) {
        receipts.push({...base, status: "pending"})
        continue
      }
      try {
        const deleted = await s.purge(scopeId)
        const held = s.legalHold ? await s.legalHold(scopeId) : 0
        const remaining = Math.max(0, (await s.count(scopeId)) - held)
        const status = remaining === 0 ? "complete" : "incomplete"
        receipts.push({...base, status, deleted, remaining, held})
        if (status === "complete") todo.delete(s.name)
      } catch (e) {
        receipts.push({...base, status: "failed", error: e instanceof Error ? e.message.slice(0, 120) : "error"})
      }
    }
    if (todo.size === 0) this.pending.delete(scopeId)
    return {scopeId, at: this.deps.now(), complete: todo.size === 0, stores: receipts}
  }
}

/** A simple governed store, for caches and queues that hold records by scope. */
export class ScopedMap<T> implements GovernedStore {
  private rows = new Map<string, {meta: GovernedMeta; value: T}>()

  constructor(
    readonly name: string,
    readonly category: StoreCategory,
    private readonly lifecycle: DataLifecycle,
    readonly location: GovernedStore["location"] = "phone",
  ) {
    lifecycle.register(this)
  }

  put(id: string, value: T, meta: GovernedMeta): AdmitResult {
    const ok = this.lifecycle.admit(meta)
    if (ok.ok) this.rows.set(id, {meta, value})
    return ok
  }

  get(id: string): T | undefined {
    return this.rows.get(id)?.value
  }

  delete(id: string): boolean {
    return this.rows.delete(id)
  }

  async purge(scopeId: string): Promise<number> {
    let n = 0
    for (const [id, r] of this.rows) {
      if (r.meta.scopeId === scopeId) {
        this.rows.delete(id)
        n++
      }
    }
    return n
  }

  async count(scopeId: string): Promise<number> {
    return [...this.rows.values()].filter(r => r.meta.scopeId === scopeId).length
  }
}

/** The memory service as a governed store: its own revocation path, counted. */
export function memoryStore(memory: {
  deleteScope(scopeId: string): Promise<{deleted: number}>
  list(opts: {includeExpired: boolean}): Promise<{source: {scopeId?: string}}[]>
}): GovernedStore {
  return {
    name: "memory",
    category: "memories",
    location: "phone",
    purge: async scopeId => (await memory.deleteScope(scopeId)).deleted,
    count: async scopeId => (await memory.list({includeExpired: true})).filter(m => m.source.scopeId === scopeId).length,
  }
}

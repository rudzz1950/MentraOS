/**
 * @fileoverview Media from the glasses, received intact and kept only as long as allowed.
 * ANI-167 (the phone end of the transfer) and ANI-169 (media lifecycle).
 *
 * RECEIVING. The wire format matches glasses-fw/app/src/media/transfer.c. A
 * transfer is accepted only from the authenticated session that negotiated it.
 * Chunks are checked against their CRC, deduplicated, and may arrive in any
 * order; `missing()` is what the phone sends back to resume after a drop.
 * Nothing is exposed until every chunk is in AND the whole file matches the
 * manifest's SHA-256 — an interrupted or tampered transfer resumes or fails,
 * and never yields a corrupt image. When only BLE is available (no
 * high-throughput link), small stills are allowed and clips are refused.
 *
 * KEEPING. Media is stored encrypted, through a Cipher port (the platform
 * keystore on the phone; WebCrypto AES-GCM here and in tests). Every capture
 * and every derivative — thumbnail, OCR text, summary, cached model output —
 * is a governed record in the data lifecycle (pce/lifecycle.ts): it is refused
 * without a live scope, it expires with the capture, and revoking the scope
 * deletes all of it with a per-store receipt that contains counts, not content.
 */

import {DataLifecycle, ScopedMap, type GovernedMeta, type GovernedStore} from "../pce/lifecycle"

export const MAX_MEDIA_BYTES = 512 * 1024
/** Over BLE alone, only stills this small are accepted. */
export const BLE_ONLY_MAX_BYTES = 64 * 1024

export interface Manifest {
  id: number
  total: number
  chunkSize: number
  nChunks: number
  sha256: Uint8Array
  sealed: boolean
}

export function parseManifest(f: Uint8Array): Manifest | null {
  if (f.length !== 44 || f[0] !== 0xb1) return null
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength)
  return {id: v.getUint16(1, true), total: v.getUint32(3, true), chunkSize: v.getUint16(7, true), nChunks: v.getUint16(9, true), sha256: f.slice(11, 43), sealed: f[43] === 1}
}

export function parseChunk(f: Uint8Array): {id: number; index: number; data: Uint8Array; crc: number} | null {
  if (f.length < 11 || f[0] !== 0xb0) return null
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength)
  const len = v.getUint16(5, true)
  if (f.length !== 11 + len) return null
  return {id: v.getUint16(1, true), index: v.getUint16(3, true), crc: v.getUint32(7, true), data: f.slice(11)}
}

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

/** Seal and open bytes. On the phone, backed by the platform keystore. */
export interface Cipher {
  seal(plain: Uint8Array, context: string): Promise<Uint8Array>
  open(sealed: Uint8Array, context: string): Promise<Uint8Array>
}

/** AES-256-GCM with a random 96-bit IV prefixed, the context as associated data. */
export class WebCryptoCipher implements Cipher {
  private constructor(private readonly key: CryptoKey) {}
  static async generate(): Promise<WebCryptoCipher> {
    return new WebCryptoCipher(await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]))
  }
  async seal(plain: Uint8Array, context: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context)}, this.key, plain as BufferSource))
    const out = new Uint8Array(12 + ct.length)
    out.set(iv)
    out.set(ct, 12)
    return out
  }
  async open(sealed: Uint8Array, context: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: new TextEncoder().encode(context)}, this.key, sealed.slice(12) as BufferSource))
  }
}

export type ReceiveError = "wrong_session" | "too_large" | "not_sealed" | "clip_needs_fast_link" | "bad_frame" | "unknown_transfer" | "crc" | "integrity" | "timeout" | "incomplete"

export interface MediaObject {
  transferId: number
  bytes: Uint8Array
  sha256Hex: string
  receivedAt: number
}

/** Unseals one chunk of a transfer; the inverse of the glasses' seal hook. */
export type ChunkOpener = (id: number, index: number, data: Uint8Array) => Promise<Uint8Array> | Uint8Array

export class TransferReceiver {
  private manifest: Manifest | null = null
  private chunks = new Map<number, Uint8Array>()
  private startedAt = 0
  private failed: ReceiveError | null = null

  constructor(
    private readonly opts: {
      sessionId: string
      now: () => number
      /** Whether a high-throughput link is up. False means BLE only. */
      fastLink: boolean
      open?: ChunkOpener
      requireSealed?: boolean
      timeoutMs?: number
      kind: "still" | "clip"
    },
  ) {}

  /** The manifest arrived on a link authenticated as `sessionId`. */
  onManifest(frame: Uint8Array, sessionId: string): {ok: true} | {ok: false; reason: ReceiveError} {
    if (sessionId !== this.opts.sessionId) return this.fail("wrong_session")
    const m = parseManifest(frame)
    if (!m || m.nChunks === 0 || m.chunkSize === 0 || Math.ceil(m.total / m.chunkSize) !== m.nChunks) return this.fail("bad_frame")
    if (m.total > MAX_MEDIA_BYTES) return this.fail("too_large")
    if ((this.opts.requireSealed ?? true) && !m.sealed) return this.fail("not_sealed")
    if (!this.opts.fastLink && (this.opts.kind === "clip" || m.total > BLE_ONLY_MAX_BYTES)) return this.fail("clip_needs_fast_link")
    this.manifest = m
    this.startedAt = this.opts.now()
    return {ok: true}
  }

  /** One chunk. Returns whether it was taken; a bad CRC is simply not acknowledged. */
  async onChunk(frame: Uint8Array): Promise<{ok: true; ackIndex: number} | {ok: false; reason: ReceiveError}> {
    const m = this.manifest
    if (!m) return {ok: false, reason: "unknown_transfer"}
    const c = parseChunk(frame)
    if (!c || c.id !== m.id || c.index >= m.nChunks) return {ok: false, reason: c ? "unknown_transfer" : "bad_frame"}
    if (crc32(c.data) !== c.crc) return {ok: false, reason: "crc"}
    const expectLen = c.index === m.nChunks - 1 ? m.total - c.index * m.chunkSize : m.chunkSize
    if (c.data.length !== expectLen) return {ok: false, reason: "bad_frame"}
    if (!this.chunks.has(c.index)) {
      const plain = this.opts.open ? await this.opts.open(m.id, c.index, c.data) : c.data
      this.chunks.set(c.index, plain)
    }
    return {ok: true, ackIndex: c.index}
  }

  /** Chunk indices still needed, for the resume request. */
  missing(): number[] {
    const m = this.manifest
    if (!m) return []
    const out: number[] = []
    for (let i = 0; i < m.nChunks; i++) if (!this.chunks.has(i)) out.push(i)
    return out
  }

  timedOut(): boolean {
    return !!this.manifest && this.opts.now() - this.startedAt > (this.opts.timeoutMs ?? 15_000)
  }

  /** The finished media, or why not. Never partial, never unverified. */
  async complete(): Promise<{ok: true; media: MediaObject} | {ok: false; reason: ReceiveError}> {
    if (this.failed) return {ok: false, reason: this.failed}
    const m = this.manifest
    if (!m) return {ok: false, reason: "unknown_transfer"}
    if (this.missing().length) return {ok: false, reason: this.timedOut() ? "timeout" : "incomplete"}
    const bytes = new Uint8Array(m.total)
    for (let i = 0; i < m.nChunks; i++) bytes.set(this.chunks.get(i)!, i * m.chunkSize)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))
    if (!digest.every((b, i) => b === m.sha256[i])) {
      this.chunks.clear()
      return this.fail("integrity")
    }
    return {ok: true, media: {transferId: m.id, bytes, sha256Hex: [...digest].map(b => b.toString(16).padStart(2, "0")).join(""), receivedAt: this.opts.now()}}
  }

  private fail(reason: ReceiveError): {ok: false; reason: ReceiveError} {
    this.failed = reason
    this.manifest = null
    return {ok: false, reason}
  }
}

/** Capture media and its derivatives, encrypted at rest, governed by the data lifecycle. */
export class MediaStore implements GovernedStore {
  readonly name = "capture_media"
  readonly category = "capture_media" as const
  readonly location = "phone" as const
  private rows = new Map<string, {sealed: Uint8Array; meta: GovernedMeta; width?: number; height?: number}>()
  readonly thumbnails: ScopedMap<Uint8Array>
  readonly ocr: ScopedMap<string>
  readonly summaries: ScopedMap<string>
  readonly modelCache: ScopedMap<unknown>

  constructor(private readonly deps: {lifecycle: DataLifecycle; cipher: Cipher; now: () => number}) {
    deps.lifecycle.register(this)
    this.thumbnails = new ScopedMap("capture_thumbnails", "capture_media", deps.lifecycle)
    this.ocr = new ScopedMap("capture_ocr", "ocr", deps.lifecycle)
    this.summaries = new ScopedMap("capture_summaries", "summaries", deps.lifecycle)
    this.modelCache = new ScopedMap("capture_model_cache", "tool_caches", deps.lifecycle)
  }

  /** Store a capture. Refused without complete, live, granted metadata — a bystander capture with no scope never lands. */
  async put(ref: string, bytes: Uint8Array, meta: GovernedMeta): Promise<{ok: true; ref: string} | {ok: false; reason: string}> {
    if (!/^media:[A-Za-z0-9._-]{1,64}$/.test(ref)) return {ok: false, reason: "bad_ref"}
    const admit = this.deps.lifecycle.admit(meta)
    if (!admit.ok) return admit
    this.rows.set(ref, {sealed: await this.deps.cipher.seal(bytes, ref), meta})
    return {ok: true, ref}
  }

  /** The plaintext, only while the capture is live. */
  async get(ref: string): Promise<Uint8Array | null> {
    const r = this.rows.get(ref)
    if (!r) return null
    if (r.meta.expiresAt <= this.deps.now() || this.deps.lifecycle.admit(r.meta).ok === false) {
      await this.dropRef(ref)
      return null
    }
    return this.deps.cipher.open(r.sealed, ref)
  }

  meta(ref: string): GovernedMeta | undefined {
    return this.rows.get(ref)?.meta
  }

  /** What is at rest: never the plaintext. For the test that proves encryption. */
  rawAtRest(ref: string): Uint8Array | undefined {
    return this.rows.get(ref)?.sealed
  }

  /** Delete captures and derivatives whose retention ran out. */
  async expire(): Promise<number> {
    const now = this.deps.now()
    let n = 0
    for (const [ref, r] of [...this.rows]) {
      if (r.meta.expiresAt <= now) {
        await this.dropRef(ref)
        n++
      }
    }
    return n
  }

  // GovernedStore: revocation purges the media; the derivative maps purge themselves.
  async purge(scopeId: string): Promise<number> {
    let n = 0
    for (const [ref, r] of [...this.rows]) {
      if (r.meta.scopeId === scopeId) {
        this.rows.delete(ref)
        n++
      }
    }
    return n
  }

  async count(scopeId: string): Promise<number> {
    return [...this.rows.values()].filter(r => r.meta.scopeId === scopeId).length
  }

  private async dropRef(ref: string): Promise<void> {
    this.rows.delete(ref)
    for (const m of [this.thumbnails, this.ocr, this.summaries, this.modelCache]) m.delete(ref)
  }
}

/**
 * @fileoverview The Bus port, per ADR-001 (ANI-21): publish, subscribe, query.
 *
 * Components depend on this interface and never on a transport. The Zenoh
 * adapter implements it in its own module and is the only file allowed to
 * import Zenoh (scripts/check-bus-imports.py enforces that), so tests run on
 * the in-memory bus below with no vendor dependency at all.
 */

import type {EventEnvelope, Priority} from "./envelope"

export type Unsubscribe = () => void

export interface Bus {
  publish(event: EventEnvelope): Promise<void>
  /** `type` is an exact event type, or a prefix ending in ".*". */
  subscribe(type: string, handler: (event: EventEnvelope) => void): Unsubscribe
  /** The latest event of a type, e.g. current device state on reconnect. */
  query(type: string): Promise<EventEnvelope | null>
}

function matches(pattern: string, type: string): boolean {
  return pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type
}

/** For tests and for in-process wiring. Synchronous delivery, in publish order. */
export class InMemoryBus implements Bus {
  private handlers: {type: string; fn: (e: EventEnvelope) => void}[] = []
  private latest = new Map<string, EventEnvelope>()
  readonly published: EventEnvelope[] = []

  async publish(event: EventEnvelope): Promise<void> {
    this.published.push(event)
    this.latest.set(event.eventType, event)
    for (const h of [...this.handlers]) if (matches(h.type, event.eventType)) h.fn(event)
  }

  subscribe(type: string, fn: (e: EventEnvelope) => void): Unsubscribe {
    const h = {type, fn}
    this.handlers.push(h)
    return () => {
      this.handlers = this.handlers.filter(x => x !== h)
    }
  }

  async query(type: string): Promise<EventEnvelope | null> {
    return this.latest.get(type) ?? null
  }
}

const RANK: Record<Priority, number> = {safety: 0, interactive: 1, bulk_ref: 2, telemetry: 3}

/**
 * An outbound queue for a link that may be slow or down, bounded by count.
 *
 * Full means something has to go, and the order is: expired first, then the
 * oldest telemetry, then the oldest bulk reference. Interactive commands are
 * refused rather than evicting older ones; safety events are never dropped,
 * and may exceed the bound, because losing "stop recording" to make room is
 * the one trade that is never right.
 */
export class BoundedQueue {
  private items: {event: EventEnvelope; enqueuedAt: number}[] = []
  readonly dropped: {eventId: string; reason: "expired" | "evicted" | "refused"}[] = []

  constructor(private readonly capacity: number, private readonly now: () => number) {
    if (!(capacity > 0)) throw new Error("capacity must be positive")
  }

  get size() {
    return this.items.length
  }

  push(event: EventEnvelope): boolean {
    this.expire()
    if (this.items.length >= this.capacity && event.priority !== "safety") {
      const victim = this.victim()
      if (victim < 0 || RANK[this.items[victim].event.priority] < RANK[event.priority]) {
        this.dropped.push({eventId: event.eventId, reason: "refused"})
        return false
      }
      this.dropped.push({eventId: this.items[victim].event.eventId, reason: "evicted"})
      this.items.splice(victim, 1)
    }
    this.items.push({event, enqueuedAt: this.now()})
    return true
  }

  /** Highest priority first, then oldest. Expired events are dropped, not sent. */
  shift(): EventEnvelope | undefined {
    this.expire()
    if (!this.items.length) return undefined
    let best = 0
    for (let i = 1; i < this.items.length; i++) {
      if (RANK[this.items[i].event.priority] < RANK[this.items[best].event.priority]) best = i
    }
    return this.items.splice(best, 1)[0].event
  }

  private expire() {
    const t = this.now()
    this.items = this.items.filter(i => {
      const dead = t - i.enqueuedAt > i.event.ttlMs
      if (dead) this.dropped.push({eventId: i.event.eventId, reason: "expired"})
      return !dead
    })
  }

  /** Index of the oldest lowest-priority evictable item, or -1. */
  private victim(): number {
    let v = -1
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i].event.priority
      if (p === "safety" || p === "interactive") continue
      if (v < 0 || RANK[p] > RANK[this.items[v].event.priority]) v = i
    }
    return v
  }
}

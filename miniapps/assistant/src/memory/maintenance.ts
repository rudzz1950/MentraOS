/**
 * @fileoverview When the memory store tidies itself, decided in one place.
 *
 * `collect()` and `flushQueue()` existed, but nothing called them, so expiry
 * was a promise made at write time and kept by nobody. This is the schedule.
 *
 * It owns no timers. Like the button gesture timer, the host calls `tick()`
 * and asks `nextDeadline()` when to call it next, so the schedule is testable
 * against a fake clock and the host decides how to wake up — a JS timer while
 * the app is open, a WorkManager job when it is not.
 *
 * Every run leaves a report, kept for the transparency view: a retention
 * promise that cannot be shown to have run is not one anybody can check.
 */

import type {Clock} from "../agent/ports"

/** The slice of MemoryService this needs. */
export interface Maintainable {
  collect(): Promise<{deleted: number; ids: string[]}>
  flushQueue(): Promise<number>
}

export interface MaintenanceOptions {
  /**
   * How often expired memories are deleted. An hour by default: the 7-day task
   * retention is the shortest promise the store makes, so an hour's lag is
   * well inside it, and a run with nothing to do is a scan of a few thousand
   * rows.
   */
  collectEveryMs?: number
  /** How often the embedding queue is retried. Five minutes by default. */
  flushEveryMs?: number
  /** Reports kept. The oldest are dropped first. */
  historySize?: number
}

export interface MaintenanceReport {
  at: number
  /** Which jobs ran. */
  ran: ("collect" | "flush")[]
  /** Memories deleted because their retention ran out. */
  collected: number
  /** Queued memories that got their embedding. */
  embedded: number
  /** Per job, when it threw. A failing job does not stop the other one. */
  errors: {job: "collect" | "flush"; message: string}[]
}

export class MemoryMaintenance {
  private readonly collectEveryMs: number
  private readonly flushEveryMs: number
  private readonly historySize: number
  private nextCollect: number
  private nextFlush: number
  private running = false
  private readonly reports: MaintenanceReport[] = []

  constructor(
    private readonly store: Maintainable,
    private readonly clock: Clock,
    opts: MaintenanceOptions = {},
  ) {
    this.collectEveryMs = opts.collectEveryMs ?? 3_600_000
    this.flushEveryMs = opts.flushEveryMs ?? 300_000
    this.historySize = opts.historySize ?? 50
    if (!(this.collectEveryMs > 0) || !(this.flushEveryMs > 0)) {
      throw new Error("Maintenance intervals must be positive")
    }
    // Both are due at once: the app may have been closed past an expiry, and
    // the first thing a launch should do is honour it.
    const t = clock.now()
    this.nextCollect = t
    this.nextFlush = t
  }

  /** Epoch ms when `tick()` next has something to do. */
  nextDeadline(): number {
    return Math.min(this.nextCollect, this.nextFlush)
  }

  /**
   * Run whatever is due. Returns the report, or null when nothing was due or a
   * run is already in progress — overlapping runs would collect the same rows
   * twice and report both.
   */
  async tick(): Promise<MaintenanceReport | null> {
    const t = this.clock.now()
    const collectDue = t >= this.nextCollect
    const flushDue = t >= this.nextFlush
    if (this.running || (!collectDue && !flushDue)) return null
    return this.run(collectDue, flushDue)
  }

  /** Run both jobs now, whatever the schedule says. For "clean up now" in settings. */
  async runNow(): Promise<MaintenanceReport | null> {
    if (this.running) return null
    return this.run(true, true)
  }

  /** Recent reports, newest last. */
  history(): readonly MaintenanceReport[] {
    return this.reports
  }

  private async run(collect: boolean, flush: boolean): Promise<MaintenanceReport> {
    this.running = true
    const report: MaintenanceReport = {at: this.clock.now(), ran: [], collected: 0, embedded: 0, errors: []}
    try {
      if (collect) {
        report.ran.push("collect")
        try {
          report.collected = (await this.store.collect()).deleted
        } catch (err) {
          report.errors.push({job: "collect", message: messageOf(err)})
        }
        // Scheduled from when it was due, not from when it finished, so a slow
        // run does not push every later one back. A host that slept through
        // several periods gets one run, not a burst of catch-ups.
        this.nextCollect = nextAfter(this.nextCollect, this.collectEveryMs, report.at)
      }
      if (flush) {
        report.ran.push("flush")
        try {
          report.embedded = await this.store.flushQueue()
        } catch (err) {
          report.errors.push({job: "flush", message: messageOf(err)})
        }
        this.nextFlush = nextAfter(this.nextFlush, this.flushEveryMs, report.at)
      }
    } finally {
      this.running = false
    }
    this.reports.push(report)
    if (this.reports.length > this.historySize) this.reports.splice(0, this.reports.length - this.historySize)
    return report
  }
}

function nextAfter(due: number, every: number, now: number): number {
  if (due > now) return due
  return due + (Math.floor((now - due) / every) + 1) * every
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

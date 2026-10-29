/**
 * @fileoverview A rolling count over a time window.
 *
 * Shared because it is needed in two places with different windows — inbound
 * interruptions per hour and outbound messages per ten minutes — and two
 * copies of the same counter is how the panel geometry drifted out of sync in
 * the first place.
 *
 * Rolling, not bucketed: a clock-hour bucket lets six interruptions land at
 * 10:59 and six more at 11:01, which is twelve in two minutes and exactly what
 * a budget is supposed to prevent.
 */

import type {Clock} from "../agent/ports"

export class RollingWindow {
  private stamps: number[] = []

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** How many are still available. */
  remaining(): number {
    this.prune()
    return Math.max(0, this.limit - this.stamps.length)
  }

  /** True when the limit is reached. Does not spend anything. */
  exhausted(): boolean {
    return this.remaining() === 0
  }

  /**
   * Spend one if there is room. Returns false without spending when there is
   * not, so a refused action never costs anything.
   */
  tryTake(): boolean {
    if (this.exhausted()) return false
    this.stamps.push(this.clock.now())
    return true
  }

  /** Milliseconds until the next one frees up, or 0 when there is room now. */
  msUntilFree(): number {
    this.prune()
    if (this.stamps.length < this.limit) return 0
    const oldest = this.stamps[0]
    return Math.max(0, oldest + this.windowMs - this.clock.now())
  }

  /**
   * Record one even though the limit is reached. For a caller that allows an
   * action past the limit under a stricter condition and still needs the
   * window to reflect it — otherwise the limit stops applying after the first
   * time it is exceeded.
   */
  forceTake(): void {
    this.prune()
    this.stamps.push(this.clock.now())
  }

  reset(): void {
    this.stamps = []
  }

  private prune(): void {
    const cutoff = this.clock.now() - this.windowMs
    this.stamps = this.stamps.filter(t => t > cutoff)
  }
}

/**
 * @fileoverview Where a piece of context is allowed to go. ANI-25.
 *
 * "Latency for the common case, capability for the rare one" decides which
 * tier answers. It cannot decide what that tier is shown. A prompt that
 * carries someone else's words to a third-party model when their consent
 * said otherwise is a charter violation, not a performance trade-off — so
 * consent bounds the destination first, and routing chooses within that.
 *
 * Three places a model can run, in order of how far data travels:
 *
 *   device  on the phone or the puck. Nothing leaves the wearer's hardware.
 *   site    an endpoint the deploying organisation runs (ADR-003's on-premise
 *           case). Leaves the device, not the organisation.
 *   cloud   a third party. Also the assumption for any tier that does not
 *           say: an endpoint nobody described is treated as the farthest one,
 *           because the opposite default is how a leak gets configured.
 *
 * Every item of context has a REACH: the farthest it may go. A tier only sees
 * the items whose reach includes it, so a cloud tier still answers — it just
 * answers without what it may not see. Withholding context can make an answer
 * worse; sending it would make the product something else.
 */

import type {Memory} from "../memory/types"

export type Locality = "device" | "site" | "cloud"

const RANK: Record<Locality, number> = {device: 0, site: 1, cloud: 2}

/** True when something with this reach may be sent to a tier at `where`. */
export function allows(reach: Locality, where: Locality): boolean {
  return RANK[where] <= RANK[reach]
}

/** The tighter of two reaches. */
export function narrower(a: Locality, b: Locality): Locality {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * What the consent ledger says a scope's data may do. The ledger is not in
 * this repo; this is the slice the assistant needs from it.
 */
export interface ConsentPolicy {
  /**
   * The farthest a scope's captured data may travel, or null when the scope is
   * unknown here. Unknown is treated as device-only, never as unrestricted.
   */
  reach(scopeId: string): Locality | null
}

/**
 * The default until the ledger is wired: captured data never leaves the
 * device. Strict on purpose. Getting this wrong in the permissive direction
 * cannot be undone by a later fix — the words have already been sent.
 */
export const DEVICE_ONLY: ConsentPolicy = {reach: () => "device"}

/**
 * The reach of one memory.
 *
 * Self-reported memories are the wearer's own words about themselves, sent to
 * the tiers the wearer's deployment configured; they are unrestricted here, as
 * they always have been. Captured memories carry a consent scope and go only
 * as far as that scope allows.
 */
export function memoryReach(m: Memory, policy: ConsentPolicy): Locality {
  if ((m.source.provenance ?? "self_reported") !== "captured") return "cloud"
  if (!m.source.scopeId) return "device"
  return policy.reach(m.source.scopeId) ?? "device"
}

/**
 * @fileoverview Replying to the message that is on the panel.
 *
 * THE BUG THIS FIXES. The message card said "Say reply to answer" and nothing
 * anywhere handled the word "reply". The HUD was telling the wearer to say
 * something the system could not act on — worse than silence, because it reads
 * as a feature that is broken rather than one that is absent.
 *
 * Worse than that, it said it unconditionally. A reply can only go back
 * through the notification's own reply action, and iOS gives accessories ANCS
 * read-only with interactive forwarding EU-only from 26.5 — which excludes
 * India. So on an iPhone here the card was promising something the platform
 * forbids. The prompt is now conditional on a reply action actually existing.
 *
 * WHY THE TARGET EXPIRES. "Reply" means the message the wearer is looking at.
 * A reply target that outlived its card would let "reply, I'm on my way" land
 * on whatever arrived twenty minutes ago, to someone else entirely. The window
 * is therefore tied to the card's own lifetime, and one reply consumes it.
 */

import type {PhoneNotification} from "../hud/notify"
import {senderOf} from "../hud/notify"
import type {Clock} from "./ports"

export interface ReplyTarget {
  notificationId: string
  /** Android NotificationKey, which is what the reply action is keyed on. */
  notificationKey?: string
  packageName: string
  sender: string
  expiresAt: number
}

/** What a platform reply action needs. Supplied by the host; never assumed. */
export interface ReplySender {
  /**
   * Invoke the notification's own reply action. There is no general
   * message-sending API on either platform, so this is the only route.
   */
  send(target: ReplyTarget, text: string): Promise<void>
}

export interface ReplyContextOptions {
  clock: Clock
  /**
   * How long after the card appears a reply is still understood to mean it.
   * Matches the message card's own ttl by default.
   */
  windowMs?: number
}

export class ReplyContext {
  private readonly clock: Clock
  private readonly windowMs: number
  private target: ReplyTarget | null = null

  constructor(opts: ReplyContextOptions) {
    this.clock = opts.clock
    this.windowMs = opts.windowMs ?? 6000
  }

  /**
   * A message card was shown. Only offers a reply target when the platform
   * actually handed over a reply action.
   */
  offer(n: PhoneNotification): ReplyTarget | null {
    if (!n.canReply) {
      this.target = null
      return null
    }
    this.target = {
      notificationId: n.notificationId,
      notificationKey: n.notificationKey,
      packageName: n.packageName,
      sender: senderOf(n),
      expiresAt: this.clock.now() + this.windowMs,
    }
    return this.target
  }

  /** The live target, or null when there is none or it has expired. */
  current(): ReplyTarget | null {
    if (this.target === null) return null
    if (this.clock.now() >= this.target.expiresAt) {
      this.target = null
      return null
    }
    return this.target
  }

  clear(): void {
    this.target = null
  }

  /**
   * Pull the reply body out of an utterance, or null when this is not a reply.
   *
   * "reply" alone is not a reply: it names the intent with no content, and
   * sending an empty message is worse than asking what to say.
   */
  parse(text: string): string | null {
    // `saying\s*` not `saying\s+`: with the plus, "reply saying" failed to
    // match the filler group and fell through with a body of "saying", which
    // would have sent that word as the message.
    const m = text.trim().match(/^(?:reply|respond|answer|tell (?:him|her|them))\b[,:]?\s*(?:saying\s*)?(.*)$/i)
    if (!m) return null
    const body = m[1].trim()
    return body.length > 0 ? body : null
  }

  /** True when the utterance asks to reply but says nothing to send. */
  isBareReply(text: string): boolean {
    return /^(?:reply|respond|answer|tell (?:him|her|them))\b[,:]?\s*(?:saying\s*)?$/i.test(text.trim())
  }
}

/**
 * @fileoverview What the phone and HUD say about the camera. ANI-172, phone side.
 *
 * The glasses report their camera state (glasses-fw/app/src/camera/capture.c,
 * which already reports conservatively). The phone's job is not to make that
 * report more optimistic than the evidence. In particular, a capture that was
 * in progress when the link dropped, or the app crashed, is shown as
 * "camera may be active" until the glasses confirm otherwise — the link going
 * quiet is not evidence that the camera stopped.
 *
 * The UI can say five things:
 *   off           the glasses confirmed the camera is disabled or ready
 *   capturing     the glasses say capturing, or transferring
 *   uncertain     the last known state was active (or unknown) and there is no
 *                 current report: "camera may be active"
 *   disconnected  no current report, and the last one was off: "glasses not
 *                 connected", which claims nothing about the camera
 *   fault         the glasses reported the indicator fault (ANI-12)
 *
 * "off" is never shown on inference. It needs a fresh report.
 */

export type DeviceCameraState = "disabled" | "ready" | "capturing" | "transferring" | "error"
export type UiCameraState = "off" | "capturing" | "uncertain" | "disconnected" | "fault"

export class CameraIndicatorView {
  private last: DeviceCameraState | null = null
  private lastAt = 0
  private linkUp = false

  constructor(private readonly opts: {now: () => number; staleAfterMs?: number}) {}

  report(state: DeviceCameraState): void {
    this.last = state
    this.lastAt = this.opts.now()
    this.linkUp = true
  }

  linkLost(): void {
    this.linkUp = false
  }

  /** After an app crash the view is rebuilt with no evidence: it starts uncertain if a capture was open. */
  static afterCrash(opts: {now: () => number}, captureWasOpen: boolean): CameraIndicatorView {
    const v = new CameraIndicatorView(opts)
    if (captureWasOpen) v.last = "capturing"
    return v
  }

  state(): UiCameraState {
    if (this.last === "error") return "fault"
    const stale = this.opts.now() - this.lastAt > (this.opts.staleAfterMs ?? 5000)
    const active = this.last === "capturing" || this.last === "transferring"
    if (!this.linkUp || stale) {
      // No current evidence. Anything that was, or might have been, active stays in doubt.
      return active || this.last === null ? "uncertain" : "disconnected"
    }
    return active ? "capturing" : "off"
  }

  label(): string {
    switch (this.state()) {
      case "off":
        return "Camera off"
      case "capturing":
        return "Camera recording"
      case "uncertain":
        return "Camera may be active"
      case "disconnected":
        return "Glasses not connected"
      case "fault":
        return "Camera indicator fault: camera disabled"
    }
  }
}

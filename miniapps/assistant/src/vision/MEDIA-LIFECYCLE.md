# Captures: what is kept, for how long, and how to remove it (ANI-169)

**For the wearer.** The glasses take a photo only when you ask, and only while the
physical camera switch is on; the recording light is wired to the camera's power and
software cannot turn it off. The phone app shows the camera as *off*, *recording*,
*may be active* (the glasses went quiet mid-capture) or *not connected* — it never
says "off" without the glasses confirming it.

| What | Where | Kept for | Removed by |
| --- | --- | --- | --- |
| The photo | Phone, encrypted with a key in the phone's keystore | Until the question session ends — two minutes by default (`captureTtlMs`) | Expiry, *Clear current context*, or withdrawing the capture's consent |
| Thumbnail, label text (OCR), summary, model answer | Phone, alongside the photo | The same as the photo: they expire with it | The same: they are deleted with the photo |
| Remembering a product | Memory, only if you say so | Your memory settings | Deleting the memory, or withdrawing consent |

Nothing from a capture is ever used to train a model (ANI-90).

**Withdrawing consent** for a capture (Settings → Data → Active consents) deletes the
photo and every derivative from every store that has registered one, including the
glasses' cache once they reconnect, and shows a receipt: for each store, how many
records were deleted and whether any remain. The receipt contains counts, never the
content it deleted.

**For developers.** Every store holding capture data registers with
`pce/lifecycle.ts` and calls `admit()` on write, so an unscoped or revoked write is
refused at the store rather than by convention. `MediaStore` registers the photo and
its four derivative stores; anything new that keeps capture data must do the same, and
`DataLifecycle.gaps()` lists categories nothing has registered for.

# Refusals that live next to the audio code

Put here rather than only in Notion, because this is where the temptation is.

## No speaker identification. No diarization. No voice prints.

A speaker embedding **is** a biometric template, and the privacy charter says
none is ever computed, stored or transmitted. `03 — Tech & Architecture` calls
that constraint the moat: a competitor can add voice recognition in a sprint,
and cannot add *"we structurally cannot"* after shipping something that can.

"Who said what" is the obvious next feature. It would arrive in a library call,
without anyone deciding to add it. `scripts/check-no-voice-biometrics.py` fails
the build instead.

**Deleting the embedding afterwards is not sufficient. Computed is computed.**

Within-session turn separation that stores nothing is *arguably* outside the
charter. The burden of proof sits on whoever proposes it, and if it is ever
allowed it is allowed by an ADR that also updates the check — never by a pull
request that adds an ignore.

### Use this instead

The **consent-scoped identity token exchange** from `03`: two consenting devices
swap a rotating, revocable pseudonymous token, and memory is keyed on that
token. Revoking consent revokes the memory. No face, no embedding, no template.

This is the differentiated version, not a compromise.

## No fine-tuning on captured user data

ADR-002 requires revocation to be *provably complete*. A database honours
`DELETE WHERE scope_id = ?`. **Weights do not.** A model trained on captured
audio cannot unlearn it when the person revokes, and we would be asserting a
deletion we cannot perform. Machine unlearning is a research area, not a
compliance control.

Fine-tune on synthetic and curated data only. There is no "learns from your
usage" feature, however well it would demo. Personalisation comes from
retrieval into the context window, which is revocable and auditable — see
`memory/consolidate.ts` and the `scopeId` rule in `memory/types.ts`.

## Cloud STT sends a bystander's voice abroad

Routing audio to a cloud recogniser means someone who consented to nothing has
their voice processed in another country. Cross-border transfer rules bite here
(ANI-69, DPDP Rule 15). On-device STT is not only a latency decision.

## Known contradiction, not yet resolved

Upstream MentraOS ships `diarization?: boolean` on its transcription config,
and `speakerId` on transcription events "when the provider reports diarization".
**Our fork inherits that**, so the charter claim is not currently true of the
build. `--audit` on the check lists the surfaces. This needs a decision: remove
them from the fork, or stop making the claim in that form. See ANI-91.

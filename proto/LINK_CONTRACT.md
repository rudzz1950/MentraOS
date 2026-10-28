# Phone <-> glasses link contract (v0, matches MentraOS `MentraNex` driver @ 7f35407)

Single source of truth for the firmware agent and the app agent. Change only by agreement; bump `CONTRACT_VERSION`.

CONTRACT_VERSION = 0

## GATT
| Role | UUID |
|---|---|
| Service | 00004860-0000-1000-8000-00805f9b34fb |
| Phone -> glasses (write / write-without-response) | 000071FF-0000-1000-8000-00805f9b34fb |
| Glasses -> phone (notify) | 000070FF-0000-1000-8000-00805f9b34fb |
| CCCD | 0x2902 |

Source: `bluetooth-sdk/android/.../utils/NexSGCUtils.kt:39-42`.

## Packet types (first byte)
| Byte | Meaning |
|---|---|
| 0x01 | JSON (legacy, phone ignores unless needed) |
| 0x02 | Protobuf control |
| 0xA0 | Audio (LC3) |
| 0xB0 | Image chunk |

## Phone -> glasses protobuf framing (as implemented, NOT the 1-byte form in firmware-spec.mdx)
`[0x02][seq u8][total_chunks u8][chunk_index u8][fragment...]`
- seq increments per message, wraps at 255.
- Fragment size = negotiated MTU payload - 4.
- Firmware reassembles by (seq, index); total_chunks==1 is the fast path.
- Payload after reassembly = serialized `mentraos.ble.PhoneToGlasses`.
Source: `MentraNex.kt` `sendProtobuf()` lines ~1872-1915.

## Glasses -> phone protobuf
`[0x02][serialized GlassesToPhone]` in a single notification (no fragmentation header).
Source: `MentraNex.kt` `onCharacteristicChangedHandler()` ~line 1186.

## Audio glasses -> phone
`[0xA0][seq u8][LC3 bytes...]`
- LC3, 16 kHz mono, 10 ms frames, 40 bytes/frame default (`DeviceManager.handleGlassesMicData(frameSize = 40)`).
- seq increments per packet; phone logs gaps.

## Schema
`mentraos_ble.proto` in this folder was reconstructed from the descriptor embedded in
`MentraosBle.java` and verified field-for-field identical (ignoring json_name/options).
Spec v2 additions (CommandResult, SetHomeScreen, SyncClock, Update, UploadFont, AncsNotification)
are NOT in v0. Add them in a v1 with new field numbers only.

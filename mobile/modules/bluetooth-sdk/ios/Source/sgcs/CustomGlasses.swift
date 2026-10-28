import Foundation

// TODO(sprint-2): iOS driver for Custom Glasses.
//
// Not implemented. Sprint 1 targets Android only, so the Mentra App on iOS does
// not offer this device: DeviceManager.swift has no `DeviceTypes.CUSTOM` branch,
// and nothing references this file yet.
//
// When it is written, mirror `CustomGlasses.kt` exactly — the wire format is the
// contract, not the code:
//   - service 0x4860, write 0x71FF, notify 0x70FF (NexBluetoothConstants equivalents)
//   - phone -> glasses: [0x02][seq][total][index][fragment], fragment = MTU - 3 - 4
//   - glasses -> phone: [0x02][GlassesToPhone], [0xA0][seq][LC3 frame, 40 bytes]
//   - scan by name prefix "MYGL-" or by the service UUID in the advertisement
//   - CoreBluetooth caps the write payload at `maximumWriteValueLength(for:)`;
//     read it instead of assuming the negotiated MTU, then subtract the 4-byte header
//   - iOS has no ANCS consumer on this side: notification relay is firmware work
//
// See myglasses/proto/LINK_CONTRACT.md and tools/myglasses/golden_vectors.json.

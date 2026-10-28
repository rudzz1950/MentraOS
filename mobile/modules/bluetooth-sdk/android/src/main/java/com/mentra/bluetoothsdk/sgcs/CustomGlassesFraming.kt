package com.mentra.bluetoothsdk.sgcs

/**
 * Pure framing helpers for Custom Glasses (LINK_CONTRACT v0). No Android types, so the
 * rules are unit-tested on the JVM and mirrored byte-for-byte by tools/myglasses/golden_vectors.py.
 *
 * Phone -> glasses control: [0x02][seq][totalChunks][chunkIndex][fragment...]
 * Glasses -> phone control: [0x02][GlassesToPhone bytes]
 * Glasses -> phone audio:   [0xA0][seq][LC3 bytes...]
 */
object CustomGlassesFraming {
    const val PACKET_PROTOBUF: Byte = 0x02
    const val PACKET_AUDIO: Byte = 0xA0.toByte()
    const val HEADER_SIZE = 4
    /** ATT write payload = MTU - 3 (opcode + handle). */
    const val ATT_OVERHEAD = 3
    const val MTU_DEFAULT = 23
    const val MAX_CHUNKS = 255

    /** Bytes of protobuf payload that fit in one frame at [mtu]. */
    fun fragmentSize(mtu: Int): Int = (mtu - ATT_OVERHEAD - HEADER_SIZE).coerceAtLeast(1)

    /**
     * Splits [payload] into frames for [mtu] with sequence number [seq] (0..255).
     * Returns null if the message would need more than 255 fragments.
     */
    fun frame(payload: ByteArray, seq: Int, mtu: Int): List<ByteArray>? {
        val frag = fragmentSize(mtu)
        val total = if (payload.isEmpty()) 1 else (payload.size + frag - 1) / frag
        if (total > MAX_CHUNKS) return null
        return (0 until total).map { index ->
            val start = index * frag
            val end = minOf(start + frag, payload.size)
            val out = ByteArray(HEADER_SIZE + (end - start))
            out[0] = PACKET_PROTOBUF
            out[1] = (seq and 0xFF).toByte()
            out[2] = total.toByte()
            out[3] = index.toByte()
            if (end > start) System.arraycopy(payload, start, out, HEADER_SIZE, end - start)
            out
        }
    }

    /** Next sequence number after [seq], wrapping 255 -> 0. */
    fun nextSeq(seq: Int): Int = (seq + 1) and 0xFF

    /** Inbound packet, split by type. */
    sealed class Inbound {
        class Control(val protobuf: ByteArray) : Inbound()
        class Audio(val seq: Int, val lc3: ByteArray) : Inbound()
        class Unknown(val type: Int) : Inbound()
        object Empty : Inbound()
    }

    fun parseInbound(data: ByteArray): Inbound {
        if (data.isEmpty()) return Inbound.Empty
        return when (data[0]) {
            PACKET_PROTOBUF -> Inbound.Control(data.copyOfRange(1, data.size))
            PACKET_AUDIO ->
                if (data.size < 2) Inbound.Unknown(0xA0)
                else Inbound.Audio(data[1].toInt() and 0xFF, data.copyOfRange(2, data.size))
            else -> Inbound.Unknown(data[0].toInt() and 0xFF)
        }
    }
}

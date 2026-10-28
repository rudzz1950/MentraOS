package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Framing rules from LINK_CONTRACT v0. tools/myglasses/golden_vectors.py emits the
 * same frames for the firmware's decoder tests; both must agree byte for byte.
 */
class CustomGlassesFramingTest {

    private fun header(frame: ByteArray) = frame.take(4).map { it.toInt() and 0xFF }

    @Test
    fun `fragment size subtracts ATT and transport headers`() {
        // MTU 23 -> 20 ATT payload bytes -> 16 after the 4-byte header.
        assertThat(CustomGlassesFraming.fragmentSize(23)).isEqualTo(16)
        assertThat(CustomGlassesFraming.fragmentSize(247)).isEqualTo(240)
        // Never zero or negative, however small the MTU is reported.
        assertThat(CustomGlassesFraming.fragmentSize(5)).isEqualTo(1)
    }

    @Test
    fun `a short message is one frame`() {
        val payload = ByteArray(10) { it.toByte() }
        val frames = CustomGlassesFraming.frame(payload, seq = 7, mtu = 247)!!
        assertThat(frames).hasSize(1)
        assertThat(header(frames[0])).containsExactly(0x02, 7, 1, 0)
        assertThat(frames[0].drop(4)).isEqualTo(payload.toList())
    }

    @Test
    fun `an empty payload still sends one frame`() {
        val frames = CustomGlassesFraming.frame(ByteArray(0), seq = 0, mtu = 247)!!
        assertThat(frames).hasSize(1)
        assertThat(frames[0]).hasSize(4)
        assertThat(header(frames[0])).containsExactly(0x02, 0, 1, 0)
    }

    @Test
    fun `a long message fragments at MTU 23 and reassembles in order`() {
        val payload = ByteArray(100) { (it * 3).toByte() }
        val frames = CustomGlassesFraming.frame(payload, seq = 1, mtu = 23)!!
        // ceil(100 / 16) = 7 fragments
        assertThat(frames).hasSize(7)
        frames.forEachIndexed { index, frame ->
            assertThat(header(frame)).containsExactly(0x02, 1, 7, index)
            assertThat(frame.size).isLessThanOrEqualTo(23 - 3)
        }
        val rebuilt = frames.flatMap { it.drop(4) }
        assertThat(rebuilt).isEqualTo(payload.toList())
    }

    @Test
    fun `the same payload needs fewer fragments at MTU 247`() {
        val payload = ByteArray(100)
        assertThat(CustomGlassesFraming.frame(payload, seq = 0, mtu = 247)!!).hasSize(1)
        assertThat(CustomGlassesFraming.frame(ByteArray(500), seq = 0, mtu = 247)!!).hasSize(3)
    }

    @Test
    fun `a message needing more than 255 fragments is refused`() {
        // 256 fragments at MTU 23.
        assertThat(CustomGlassesFraming.frame(ByteArray(16 * 256), seq = 0, mtu = 23)).isNull()
        assertThat(CustomGlassesFraming.frame(ByteArray(16 * 255), seq = 0, mtu = 23)).isNotNull()
    }

    @Test
    fun `sequence wraps from 255 back to zero`() {
        assertThat(CustomGlassesFraming.nextSeq(0)).isEqualTo(1)
        assertThat(CustomGlassesFraming.nextSeq(254)).isEqualTo(255)
        assertThat(CustomGlassesFraming.nextSeq(255)).isEqualTo(0)
    }

    @Test
    fun `a wrapped sequence is written as a single byte`() {
        val frames = CustomGlassesFraming.frame(ByteArray(4), seq = 255, mtu = 247)!!
        assertThat(frames[0][1].toInt() and 0xFF).isEqualTo(255)
    }

    @Test
    fun `inbound packets split by type byte`() {
        val control = CustomGlassesFraming.parseInbound(byteArrayOf(0x02, 1, 2, 3))
        assertThat(control).isInstanceOf(CustomGlassesFraming.Inbound.Control::class.java)
        assertThat((control as CustomGlassesFraming.Inbound.Control).protobuf).containsExactly(1, 2, 3)

        val audio = CustomGlassesFraming.parseInbound(byteArrayOf(0xA0.toByte(), 9, 42, 43))
        assertThat(audio).isInstanceOf(CustomGlassesFraming.Inbound.Audio::class.java)
        audio as CustomGlassesFraming.Inbound.Audio
        assertThat(audio.seq).isEqualTo(9)
        assertThat(audio.lc3).containsExactly(42, 43)

        assertThat(CustomGlassesFraming.parseInbound(ByteArray(0)))
            .isSameAs(CustomGlassesFraming.Inbound.Empty)
        assertThat(CustomGlassesFraming.parseInbound(byteArrayOf(0xB0.toByte(), 1)))
            .isInstanceOf(CustomGlassesFraming.Inbound.Unknown::class.java)
        // A truncated audio packet carries no sequence byte; treat it as unusable.
        assertThat(CustomGlassesFraming.parseInbound(byteArrayOf(0xA0.toByte())))
            .isInstanceOf(CustomGlassesFraming.Inbound.Unknown::class.java)
    }
}

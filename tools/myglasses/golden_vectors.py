#!/usr/bin/env python3
"""Emit the exact BLE frames the phone sends for a fixed set of commands.

The firmware's decoder tests replay these bytes; CustomGlassesFramingTest.kt covers
the same framing rules on the phone side. Both follow LINK_CONTRACT v0:

    phone -> glasses: [0x02][seq][total_chunks][chunk_index][fragment...]

Usage:
    pip install protobuf grpcio-tools
    python3 golden_vectors.py -o golden_vectors.json
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

PACKET_PROTOBUF = 0x02
ATT_OVERHEAD = 3  # opcode + handle
HEADER_SIZE = 4   # [type][seq][total][index]
MTU_DEFAULT = 23
MTU_NEGOTIATED = 247

# Sprint 1 stand-in OLED, mirrored from CustomGlasses.kt / CUSTOM_PROFILE.
FONT_CODE = 0
FONT_SIZE_PX = 8
LINE_HEIGHT_PX = 16
TEXT_INTENSITY = 15


def fragment_size(mtu: int) -> int:
    return max(1, mtu - ATT_OVERHEAD - HEADER_SIZE)


def frame(payload: bytes, seq: int, mtu: int) -> list[bytes]:
    """Split a serialized PhoneToGlasses into transport frames."""
    size = fragment_size(mtu)
    total = 1 if not payload else (len(payload) + size - 1) // size
    if total > 255:
        raise ValueError(f"{total} fragments exceeds the 255 the header can carry")
    out = []
    for index in range(total):
        chunk = payload[index * size : (index + 1) * size]
        out.append(bytes([PACKET_PROTOBUF, seq & 0xFF, total, index]) + chunk)
    return out


def load_pb2(proto_path: pathlib.Path):
    """Compile the .proto to a module at run time, so no generated file is checked in."""
    out_dir = pathlib.Path(tempfile.mkdtemp(prefix="myglasses-pb2-"))
    subprocess.run(
        [
            sys.executable, "-m", "grpc_tools.protoc",
            f"-I{proto_path.parent}", f"--python_out={out_dir}", proto_path.name,
        ],
        check=True,
    )
    sys.path.insert(0, str(out_dir))
    module = proto_path.stem + "_pb2"
    return __import__(module)


def text(pb, msg_id: str, body: str, line: int = 0):
    msg = pb.PhoneToGlasses(msg_id=msg_id)
    msg.display_text.text = body
    msg.display_text.color = TEXT_INTENSITY
    msg.display_text.font_code = FONT_CODE
    msg.display_text.x = 0
    msg.display_text.y = line * LINE_HEIGHT_PX
    msg.display_text.size = FONT_SIZE_PX
    return msg


def build_cases(pb) -> list[tuple[str, str, int, object]]:
    """(name, note, mtu, PhoneToGlasses) — 20 commands the firmware must accept."""
    clear = pb.PhoneToGlasses(msg_id="clear-1")
    clear.clear_display.SetInParent()
    commit = pb.PhoneToGlasses(msg_id="commit-1")
    commit.commit.SetInParent()
    battery = pb.PhoneToGlasses(msg_id="batt-1")
    battery.battery_state.SetInParent()
    info = pb.PhoneToGlasses(msg_id="info-1")
    info.glasses_info.SetInParent()
    mic_on = pb.PhoneToGlasses(msg_id="mic-on")
    mic_on.mic_state.enabled = True
    mic_off = pb.PhoneToGlasses(msg_id="mic-off")
    mic_off.mic_state.enabled = False
    bye = pb.PhoneToGlasses(msg_id="bye-1")
    bye.disconnect.SetInParent()
    empty_id = pb.PhoneToGlasses()
    empty_id.commit.SetInParent()

    long_line = "The quick brown fox jumps over the lazy dog, again and again and again."
    return [
        ("clear_display", "start a fresh frame", MTU_NEGOTIATED, clear),
        ("commit", "paint the queued batch", MTU_NEGOTIATED, commit),
        ("commit_mtu23", "same commit at the default MTU", MTU_DEFAULT, commit),
        ("commit_no_msg_id", "msg_id omitted: proto3 default empty string", MTU_NEGOTIATED, empty_id),
        ("text_hello", "one ASCII line at the top", MTU_NEGOTIATED, text(pb, "txt-0", "Hello world", 0)),
        ("text_line1", "second line, y = 16", MTU_NEGOTIATED, text(pb, "txt-1", "Second line", 1)),
        ("text_line3", "last line of the 4-line panel, y = 48", MTU_NEGOTIATED, text(pb, "txt-3", "Fourth line", 3)),
        ("text_empty", "empty string must not crash the renderer", MTU_NEGOTIATED, text(pb, "txt-e", "", 0)),
        ("text_21_chars", "exactly one full 21-character line", MTU_NEGOTIATED, text(pb, "txt-21", "ABCDEFGHIJKLMNOPQRSTU", 0)),
        ("text_utf8_devanagari", "multi-byte UTF-8: Hindi", MTU_NEGOTIATED, text(pb, "txt-hi", "नमस्ते", 0)),
        ("text_utf8_cjk", "multi-byte UTF-8: Japanese", MTU_NEGOTIATED, text(pb, "txt-ja", "こんにちは", 1)),
        ("text_utf8_emoji", "4-byte UTF-8 sequence", MTU_NEGOTIATED, text(pb, "txt-em", "ok 👍", 2)),
        ("text_utf8_accents", "2-byte Latin-1 supplement", MTU_NEGOTIATED, text(pb, "txt-fr", "café à l'été", 0)),
        ("text_long_mtu23", "fragments at the default MTU", MTU_DEFAULT, text(pb, "txt-long", long_line, 0)),
        ("text_long_mtu247", "same text, single frame at MTU 247", MTU_NEGOTIATED, text(pb, "txt-long", long_line, 0)),
        ("text_utf8_long_mtu23", "a fragment boundary splits a UTF-8 sequence", MTU_DEFAULT, text(pb, "txt-ja-long", "こんにちは世界、これはテストです。" * 2, 0)),
        ("mic_enable", "start the LC3 mic stream", MTU_NEGOTIATED, mic_on),
        ("mic_disable", "stop the mic stream", MTU_NEGOTIATED, mic_off),
        ("battery_state", "request the battery level", MTU_NEGOTIATED, battery),
        ("glasses_info", "request firmware and model info", MTU_NEGOTIATED, info),
        ("disconnect", "intentional teardown", MTU_NEGOTIATED, bye),
    ]


def main() -> int:
    here = pathlib.Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--proto", type=pathlib.Path, default=here.parents[1] / "proto" / "mentraos_ble.proto",
                        help="path to mentraos_ble.proto (LINK_CONTRACT v0)")
    parser.add_argument("-o", "--out", type=pathlib.Path, default=here / "golden_vectors.json")
    args = parser.parse_args()

    if not args.proto.exists():
        print(f"proto not found: {args.proto}", file=sys.stderr)
        return 2

    pb = load_pb2(args.proto)
    vectors = []
    # One rolling sequence across the whole run, as the driver does; the last two
    # cases push it past 255 only if you extend the list, so wrapping is covered
    # explicitly by the Kotlin test instead.
    seq = 0
    for name, note, mtu, msg in build_cases(pb):
        payload = msg.SerializeToString()
        frames = frame(payload, seq, mtu)
        vectors.append({
            "name": name,
            "note": note,
            "mtu": mtu,
            "seq": seq,
            "payload_hex": payload.hex(),
            "payload_len": len(payload),
            "frames_hex": [f.hex() for f in frames],
            "frame_count": len(frames),
        })
        seq = (seq + 1) & 0xFF

    doc = {
        "contract_version": 0,
        "generator": "tools/myglasses/golden_vectors.py",
        "framing": "[0x02][seq][total_chunks][chunk_index][fragment]",
        "notes": [
            "frames_hex is exactly what the phone writes to characteristic 0x71FF.",
            "Concatenating each frame after its 4-byte header reproduces payload_hex.",
            "payload_hex is a serialized mentraos.ble.PhoneToGlasses.",
        ],
        "vectors": vectors,
    }
    args.out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

    # Self-check: reassembly must round-trip, and every frame must fit the MTU.
    for v in vectors:
        rebuilt = b"".join(bytes.fromhex(f)[HEADER_SIZE:] for f in v["frames_hex"])
        assert rebuilt.hex() == v["payload_hex"], v["name"]
        for f in v["frames_hex"]:
            assert len(bytes.fromhex(f)) <= v["mtu"] - ATT_OVERHEAD, v["name"]
        pb.PhoneToGlasses().ParseFromString(rebuilt)

    print(f"wrote {args.out} ({len(vectors)} vectors, all reassemble and re-parse)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

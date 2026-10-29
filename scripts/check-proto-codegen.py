#!/usr/bin/env python3
"""Fail if the committed generated protobuf sources have drifted from the .proto.

The schema was once recovered by decompiling a generated Java file, because the
generated code was the only thing that still matched reality. This check is what
stops that happening again: the .proto is the contract, and CI proves the
generated sources still agree with it.

It compares descriptors, not text, so a protoc version bump or a formatting
change does not fail the build. Only an actual schema difference does.

Run: python3 scripts/check-proto-codegen.py
"""
import pathlib
import re
import subprocess
import sys
import tempfile

from google.protobuf import descriptor_pb2

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROTO = ROOT / "proto" / "mentraos_ble.proto"
JAVA = (ROOT / "mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra"
        "/bluetoothsdk/sgcs/MentraosBle.java")


def descriptor_from_java(path):
    """Pull the FileDescriptorProto protoc embedded in the generated Java."""
    src = path.read_text(encoding="utf-8")
    start = src.index("descriptorData = {")
    end = src.index("};", start)
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', src[start:end])
    joined = "".join(parts)

    out = bytearray()
    i = 0
    while i < len(joined):
        ch = joined[i]
        if ch != "\\":
            out += ch.encode("utf-8")
            i += 1
            continue
        nxt = joined[i + 1]
        if nxt in "01234567":
            octal = re.match(r"[0-7]{1,3}", joined[i + 1:]).group(0)
            out.append(int(octal, 8))
            i += 1 + len(octal)
            continue
        out += {"n": b"\n", "t": b"\t", "r": b"\r", '"': b'"', "\\": b"\\",
                "'": b"'", "b": b"\b", "f": b"\f"}[nxt]
        i += 2
    fd = descriptor_pb2.FileDescriptorProto()
    fd.ParseFromString(bytes(out))
    return fd


def descriptor_from_proto(path):
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "d.bin"
        subprocess.run(
            [sys.executable, "-m", "grpc_tools.protoc", f"-I{path.parent}",
             f"--descriptor_set_out={out}", path.name],
            check=True, cwd=path.parent,
        )
        fds = descriptor_pb2.FileDescriptorSet()
        fds.ParseFromString(out.read_bytes())
        return fds.file[0]


def canonical(fd):
    """Drop what differs between protoc versions but carries no schema meaning."""
    fd = descriptor_pb2.FileDescriptorProto.FromString(fd.SerializeToString())
    fd.ClearField("options")
    fd.ClearField("source_code_info")

    def strip(msg):
        for f in msg.field:
            f.ClearField("json_name")
        for n in msg.nested_type:
            strip(n)

    for m in fd.message_type:
        strip(m)
    return fd


def summarize(fd):
    """message.field -> number, for a difference a human can read."""
    out = {}
    for m in fd.message_type:
        for f in m.field:
            out[f"{m.name}.{f.name}"] = f.number
    return out


def main():
    if not JAVA.exists():
        print(f"generated Java not found at {JAVA}", file=sys.stderr)
        return 1

    from_proto = canonical(descriptor_from_proto(PROTO))
    from_java = canonical(descriptor_from_java(JAVA))

    if from_proto.SerializeToString(deterministic=True) == \
       from_java.SerializeToString(deterministic=True):
        print(f"ok: generated sources match {PROTO.relative_to(ROOT)}")
        return 0

    print(f"DRIFT: generated sources no longer match {PROTO.relative_to(ROOT)}\n",
          file=sys.stderr)
    a, b = summarize(from_proto), summarize(from_java)
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            print(f"  {key}: proto={a.get(key)} generated={b.get(key)}", file=sys.stderr)
    print("\nRegenerate the Kotlin, Swift and nanopb sources from the .proto and "
          "commit them. Never edit generated code by hand.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

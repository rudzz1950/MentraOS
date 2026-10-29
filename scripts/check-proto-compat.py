#!/usr/bin/env python3
"""Prove that protocol v1 and v0 still understand each other on the wire.

v0 firmware will be in the field while the phone already speaks v1, and the
reverse happens every time a device updates late. Both directions have to work,
and "protobuf handles it" is a claim worth testing rather than assuming.

Run: python3 scripts/check-proto-compat.py
"""
import pathlib
import subprocess
import sys
import tempfile

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

ROOT = pathlib.Path(__file__).resolve().parent.parent
V1 = ROOT / "proto" / "mentraos_ble_v1.proto"
V0_REV = "HEAD:proto/mentraos_ble.proto"   # the shipping schema

failures = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        failures.append(what)


class Schema:
    """One schema in its own descriptor pool.

    Both files are called mentraos_ble.proto and declare the same package, so
    generating Python modules and importing them collides: the second import
    returns the first module and the comparison silently tests a schema against
    itself. Isolated pools keep the two genuinely apart.
    """

    def __init__(self, proto_path, outdir):
        desc = outdir / "desc.bin"
        subprocess.run(
            [sys.executable, "-m", "grpc_tools.protoc", f"-I{proto_path.parent}",
             f"--descriptor_set_out={desc}", proto_path.name],
            check=True, cwd=proto_path.parent,
        )
        fds = descriptor_pb2.FileDescriptorSet()
        fds.ParseFromString(desc.read_bytes())
        self.pool = descriptor_pool.DescriptorPool()
        for f in fds.file:
            self.pool.Add(f)

    def descriptor(self, name):
        return self.pool.FindMessageTypeByName(f"mentraos.ble.{name}")

    def new(self, name):
        return message_factory.GetMessageClass(self.descriptor(name))()


def build(proto_path, outdir, _name):
    return Schema(proto_path, outdir)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp())
    v0_dir = tmp / "v0"
    v0_dir.mkdir()
    (v0_dir / "mentraos_ble.proto").write_text(
        subprocess.run(["git", "show", V0_REV], cwd=ROOT, check=True,
                       capture_output=True, text=True).stdout
    )
    v1_out, v0_out = tmp / "v1out", tmp / "v0out"
    v1_out.mkdir()
    v0_out.mkdir()
    v1 = build(V1, v1_out, "v1")
    v0 = build(v0_dir / "mentraos_ble.proto", v0_out, "v0")

    print("v1 fields are additive")
    v0_nums = {f.number for f in v0.descriptor("PhoneToGlasses").fields}
    v1_nums = {f.number for f in v1.descriptor("PhoneToGlasses").fields}
    check(v0_nums <= v1_nums, "no v0 PhoneToGlasses field was removed")
    for f in v0.descriptor("PhoneToGlasses").fields:
        same = v1.descriptor("PhoneToGlasses").fields_by_number[f.number]
        check(same.name == f.name and same.type == f.type,
              f"PhoneToGlasses field {f.number} unchanged ({f.name})")

    print("a v1 message reaches v0 firmware intact")
    msg = v1.new("PhoneToGlasses")
    msg.msg_id = "sync_1"
    msg.sync_clock.epoch_ms = 1_761_000_000_000     # v1-only payload
    msg.sync_clock.format_24h = True
    old = v0.new("PhoneToGlasses")
    old.ParseFromString(msg.SerializeToString())
    check(old.msg_id == "sync_1", "v0 still reads msg_id from a v1 message")
    check(old.WhichOneof("payload") is None,
          "v0 sees no payload it cannot handle, rather than mis-parsing one")

    print("a v0 message reaches a v1 phone intact")
    old = v0.new("PhoneToGlasses")
    old.msg_id = "txt_1"
    old.display_text.text = "Hello world"
    old.display_text.x = 0
    old.display_text.y = 16
    new = v1.new("PhoneToGlasses")
    new.ParseFromString(old.SerializeToString())
    check(new.msg_id == "txt_1" and new.display_text.text == "Hello world",
          "v1 reads a v0 display_text unchanged")
    check(new.display_text.y == 16, "coordinates survive the round trip")

    print("v0 device_info still parses under v1, with geometry simply absent")
    old = v0.new("GlassesToPhone")
    old.device_info.fw_version = "0.1.0"
    old.device_info.hw_model = "MYGL-DK1-128x64"
    new = v1.new("GlassesToPhone")
    new.ParseFromString(old.SerializeToString())
    check(new.device_info.hw_model == "MYGL-DK1-128x64", "hw_model survives")
    check(not new.device_info.HasField("display"),
          "display is absent, so the phone knows to fall back")

    print("v1 geometry round-trips")
    g = v1.new("GlassesToPhone")
    g.device_info.display.width = 128
    g.device_info.display.height = 64
    g.device_info.display.intensity_levels = 2
    g.device_info.display.encodings.append("rle_1bit")
    back = v1.new("GlassesToPhone")
    back.ParseFromString(g.SerializeToString())
    check(back.device_info.display.width == 128 and back.device_info.display.height == 64,
          "panel size survives")
    check(list(back.device_info.display.encodings) == ["rle_1bit"], "encodings survive")

    print("command_result round-trips")
    r = v1.new("GlassesToPhone")
    r.command_result.msg_id = "commit_1"
    r.command_result.status = 2   # UNSUPPORTED
    back = v1.new("GlassesToPhone")
    back.ParseFromString(r.SerializeToString())
    check(back.command_result.status == 2,
          "UNSUPPORTED survives, which is how a phone learns what firmware lacks")

    print(f"\n{len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

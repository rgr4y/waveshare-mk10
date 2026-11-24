#!/usr/bin/env python3
"""MK10/MK20 TF 卡镜像重组 (copied from src/community/mk20-flasher, adds --src and a GPT check): IMAGEWTY 解包产物 → 裸磁盘镜像 (可 dd)

布局依据 (全部来自固件包自述, 非猜测):
- cardscript.fex: boot0 @扇区16, boot_package @扇区32800
- sunxi_gpt.fex:  GPT 头@LBA1, 条目@LBA2 起 6 分区
- dlinfo.fex:     5 个下载分区名与 GPT 条目一致
- PhoenixCard 启动卡模式: GPT 备份头写在卡末尾 (altLBA 动态调整)

用法: python3 repack.py [--out mk20-raw.img] [--size-mb N]
"""
import argparse
import os
import struct
import sys
import zlib

SRC = None  # set from --src
SECTOR = 512

# GPT 条目解析结果 (sunxi_gpt.fex LBA2 起)
PARTITIONS = [
    # (name, start_lba, end_lba, download_file)
    ("boot-resource", 504, 66039, "boot-resource.fex"),
    ("env", 66040, 66543, "env.fex"),
    ("env-redund", 66544, 67047, "env.fex"),
    ("boot", 67048, 79647, "boot.fex"),
    ("rootfs", 79648, 2176799, "rootfs.fex"),
    ("UDISK", 2176800, None, None),  # UDISK 无下载文件, 剩余空间
]

BOOT0_LBA = 16
BOOTPKG_LBA = 32800
CARD_SIZE_MB = 4000
# cardscript.fex [card_boot] start: PhoenixCard shifts every GPT partition by
# this many sectors on a TF card (verified on the original MK10 card:
# boot-resource at LBA 41464 = 504 + 40960, rootfs at 120608 = 79648 + 40960).
CARD_BOOT_START = 40960


def crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def check_layout():
    """Fail loudly if the image's own GPT differs from PARTITIONS below."""
    g = open(f"{SRC}/sunxi_gpt.fex", "rb").read()
    for i, (name, slba, elba, _) in enumerate(PARTITIONS):
        e = g[1024 + i * 128:1024 + (i + 1) * 128]
        gname = e[56:].decode("utf-16le").rstrip("\0")
        gs, ge = struct.unpack_from("<QQ", e, 32)
        assert gname == name and gs == slba and (elba is None or ge == elba), \
            f"GPT entry {i} is {gname} {gs}-{ge}, script expects {name} {slba}-{elba}"
    print("GPT layout matches script table")


def build(out_path, card_mb):
    check_layout()
    total_lba = card_mb * 1024 * 1024 // SECTOR
    print(f"目标镜像: {out_path}  容量 {card_mb}MB ({total_lba} 扇区)")

    # LBA0: protective MBR (0xEE + 55AA) from sunxi_gpt.fex, not the sunxi
    # "softw411" MBR, which hosts can't use to find the GPT.
    mbr = bytearray(open(f"{SRC}/sunxi_gpt.fex", "rb").read()[:512])
    struct.pack_into("<I", mbr, 446 + 12, min(total_lba - 1, 0xFFFFFFFF))
    gpt = open(f"{SRC}/sunxi_gpt.fex", "rb").read()
    header = bytearray(gpt[512:512 + 92])   # GPT 头 92B 有效
    entries = bytearray(gpt[1024:1024 + 6 * 128])  # 6 条目 768B

    # UDISK (末分区) 扩到卡尾: end_lba = total_lba - 34
    for i in range(len(PARTITIONS)):
        for off in (32, 40):
            v = struct.unpack_from("<Q", entries, i * 128 + off)[0]
            struct.pack_into("<Q", entries, i * 128 + off, v + CARD_BOOT_START)
    udisk_idx = next(i for i, p in enumerate(PARTITIONS) if p[0] == "UDISK")
    struct.pack_into("<Q", entries, udisk_idx * 128 + 40, total_lba - 34)

    # 按卡容量重算 GPT 头字段
    struct.pack_into("<Q", header, 24, 1)               # myLBA
    struct.pack_into("<Q", header, 32, total_lba - 1)   # altLBA
    struct.pack_into("<Q", header, 40, 34)              # firstUsableLBA
    struct.pack_into("<Q", header, 48, total_lba - 34)  # lastUsableLBA
    struct.pack_into("<Q", header, 72, 2)               # partitionEntryLBA
    struct.pack_into("<I", header, 88, crc32(entries))  # entriesCRC
    struct.pack_into("<I", header, 16, 0)
    struct.pack_into("<I", header, 16, crc32(bytes(header[:92])))

    # 备份头
    bhdr = bytearray(header)
    struct.pack_into("<Q", bhdr, 24, total_lba - 1)
    struct.pack_into("<Q", bhdr, 32, 1)
    struct.pack_into("<Q", bhdr, 72, total_lba - 33)
    struct.pack_into("<I", bhdr, 16, 0)
    struct.pack_into("<I", bhdr, 16, crc32(bytes(bhdr[:92])))

    with open(out_path, "wb") as o:
        # 前部: MBR + GPT 头/条目
        o.write(mbr)
        o.write(header)
        o.write(b"\x00" * (512 - 92))          # LBA1 剩余
        o.write(entries)
        o.write(b"\x00" * (1024 - len(entries)))  # LBA2..3 填充

        def seek_write(lba, data):
            o.seek(lba * SECTOR)
            o.write(data)

        # boot0 / boot_package (cardscript 指定扇区)
        for lba, fn in ((BOOT0_LBA, "boot0_sdcard.fex"), (BOOTPKG_LBA, "boot_package.fex")):
            data = open(f"{SRC}/{fn}", "rb").read()
            seek_write(lba, data)
            print(f"  {fn:22s} → LBA {lba:<7d} {len(data):>11,}B")

        # GPT 分区内容
        for name, slba, elba, fn in PARTITIONS:
            if fn is None:
                print(f"  {name:22s} → LBA {slba + CARD_BOOT_START:<7d} (UDISK 空分区)")
                continue
            data = open(f"{SRC}/{fn}", "rb").read()
            part_size = (elba - slba + 1) * SECTOR
            assert len(data) <= part_size, f"{fn} ({len(data)}) > 分区 {part_size}"
            seek_write(slba + CARD_BOOT_START, data)
            print(f"  {fn:22s} → LBA {slba + CARD_BOOT_START:<7d} {len(data):>11,}B / 分区 {part_size // 1024 // 1024}MB")

        # 备份 GPT: 条目区 32 LBA + 头
        o.truncate(total_lba * SECTOR)
        o.seek((total_lba - 33) * SECTOR)
        o.write(entries)
        o.write(b"\x00" * (32 * SECTOR - len(entries)))
        o.write(bhdr)

    print(f"完成: {out_path} ({os.path.getsize(out_path):,}B)")


def verify(img_path):
    print("\n=== 自检 ===")
    img = open(img_path, "rb")

    def at(lba, off=0, n=8):
        img.seek(lba * SECTOR + off)
        return img.read(n)

    C = CARD_BOOT_START
    checks = [
        ("boot0 eGON.BT0", at(16, 4, 8) == b"eGON.BT0"),
        ("boot0 magic(实际)", at(16, 0, 16)),
        ("boot_package", at(32800, 0, 16)),
        ("boot ANDROID!", at(67048 + C, 0, 8) == b"ANDROID!"),
        ("rootfs ext4", at(79648 + C, 1024 + 56, 2) == b"\x53\xef"),
        ("boot-resource FAT", at(504 + C, 0x36, 5) == b"FAT16" or at(504 + C, 0x52, 5) == b"FAT32"),
        ("env CRC32 (redundant fmt)", struct.unpack("<I", at(66040 + C, 0, 4))[0] == crc32(at(66040 + C, 5, 131072 - 5))),
        ("LBA0 55AA + 0xEE", at(0, 510, 2) == b"\x55\xaa" and at(0, 450, 1) == b"\xee"),
        ("GPT header", at(1, 0, 8) == b"EFI PART"),
    ]
    for name, val in checks:
        if isinstance(val, bool):
            print(f"  {name:28s} {'✓' if val else '✗ FAIL'}")
        else:
            print(f"  {name:28s} {val!r}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir with extracted .fex files")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size-mb", type=int, default=CARD_SIZE_MB)
    args = ap.parse_args()
    SRC = args.src
    build(args.out, args.size_mb)
    verify(args.out)

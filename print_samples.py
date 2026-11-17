#!/usr/bin/env python3
"""Print font-size, Japanese, and native SII QR samples on the RP-E11.

Requires only Python 3 and system libusb, like print_hello.py.
"""

import argparse
import sys

from print_hello import main as send_to_printer


QR_DATA = b"https://example.com/"


def qr_command(data, module_size):
    """SII technical reference 6-68: DC2 ; size, GS p 1 model e v mode nL nH data."""
    if not 2 <= module_size <= 11:
        raise ValueError("QR module size must be 2..11 dots")
    if not 1 <= len(data) <= 7089:
        raise ValueError("QR data must be 1..7089 bytes")
    # Model 2, correction M, automatic version, 8-bit byte input.
    return (b"\x12;" + bytes([module_size]) + b"\x1dp\x01\x02M\x00B"
            + len(data).to_bytes(2, "little") + data)


def make_payload(section="all"):
    payload = bytearray(b"\x1b@\x1ba\x00FONT SIZE / QR TEST\n\n")
    # ESC M selects the built-in font; GS ! selects width/height multipliers.
    for font in ((0, 1) if section == "all" else ()):
        payload.extend(b"\x1bM" + bytes([font]))
        payload.extend(f"FONT {'A' if font == 0 else 'B'}\n".encode("ascii"))
        for width, height in ((1, 1), (1, 2), (2, 1), (2, 2), (3, 3), (4, 4)):
            payload.extend(f"Size {width}x{height} (W x H)\n".encode("ascii"))
            payload.extend(b"\x1d!" + bytes([((width - 1) << 4) | (height - 1)]))
            payload.extend(b"Ab123\n")
            payload.extend(b"\x1d!\x00\n")

    payload.extend(b"\x1bM\x00\x1ba\x00JAPANESE / SHIFT JIS\n")
    payload.extend(b"\x1cC\x01\x1bR\x08\x1bt\x01")
    for font in (0, 1):
        payload.extend(f"KANJI FONT {'A' if font == 0 else 'B'}\n".encode("ascii"))
        # FS ! selects the independent Kanji font and double-width/height bits.
        payload.extend(b"\x1c!" + bytes([font]))
        for text in ("こんにちは、世界！", "ひらがな カタカナ 漢字", "日本語印刷テスト", "半角: ｱｲｳｴｵ 123 ABC"):
            payload.extend(text.encode("shift_jis") + b"\n")
        payload.extend(b"Double size\n\x1c!" + bytes([font | 0x0C]))
        payload.extend("日本語テスト\n".encode("shift_jis"))
        payload.extend(b"\x1c!\x00\n")

    payload.extend(b"\x1bM\x00\x1ba\x01SII QR / MODEL 2\n")
    payload.extend(QR_DATA + b"\n")
    for module_size in (3, 5, 7):
        payload.extend(f"Module: {module_size} dots\n".encode("ascii"))
        # The printer adds a four-module quiet zone. The line buffer must be empty.
        payload.extend(qr_command(QR_DATA, module_size))
        payload.extend(b"\n")
    payload.extend(b"\x1ba\x00\nEND OF TEST\n\n\n\n\n\x1dV\x01")
    return bytes(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Build the receipt without opening USB")
    parser.add_argument("--status-only", action="store_true")
    parser.add_argument("--section", choices=("all", "japanese-qr"), default="all",
                        help="Skip the Latin font-size chart with japanese-qr")
    parser.add_argument("--ignore-paper-status", action="store_true")
    args = parser.parse_args()
    payload = make_payload(args.section)
    print(f"Section: {args.section}; Japanese A/B; SII QR modules 3/5/7; {len(payload)} bytes",
          flush=True)
    if not args.dry_run:
        options = []
        if args.status_only:
            options.append("--status-only")
        if args.ignore_paper_status:
            options.append("--ignore-paper-status")
        send_to_printer(options, payload=payload)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)

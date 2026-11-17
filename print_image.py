#!/usr/bin/env python3
"""Print one image on the SII RP-E11 (requires Pillow and libusb)."""

import argparse
from pathlib import Path
import sys

from PIL import Image, ImageOps

from print_hello import main as send_to_printer


def rasterize(path, width):
    with Image.open(path) as source:
        rgba = ImageOps.exif_transpose(source).convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    background.alpha_composite(rgba)
    height = max(1, round(rgba.height * width / rgba.width))
    gray = background.convert("L").resize((width, height), Image.Resampling.LANCZOS)
    return gray.convert("1", dither=Image.Dither.FLOYDSTEINBERG)


def make_payload(image):
    # Pillow packs white as 1; ESC/POS packs printed (black) dots as 1.
    # Send independent 128-row raster bands, followed by feed and partial cut.
    payload = bytearray(b"\x1b@")
    row_bytes = image.width // 8
    for top in range(0, image.height, 128):
        band = image.crop((0, top, image.width, min(top + 128, image.height)))
        payload.extend(b"\x1dv0\x00")
        payload.extend(row_bytes.to_bytes(2, "little"))
        payload.extend(band.height.to_bytes(2, "little"))
        payload.extend(value ^ 0xFF for value in band.tobytes())
    payload.extend(b"\n\n\n\n\n\x1dV\x01")
    return bytes(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--width", type=int, default=360,
                        help="Width in dots, multiple of 8 (default: 360 for 58mm paper)")
    parser.add_argument("--preview", type=Path, help="Save the monochrome print preview")
    parser.add_argument("--dry-run", action="store_true", help="Convert without USB access")
    parser.add_argument("--ignore-paper-status", action="store_true")
    args = parser.parse_args()
    if args.width < 8 or args.width > 432 or args.width % 8:
        parser.error("width must be a multiple of 8 between 8 and 432 for 58mm paper")
    image = rasterize(args.image, args.width)
    if image.height > 65535:
        parser.error("image is too tall")
    payload = make_payload(image)
    if args.preview:
        image.save(args.preview)
    print(f"Image: {image.width} x {image.height} dots; {len(payload)} bytes", flush=True)
    if not args.dry_run:
        send_to_printer(["--ignore-paper-status"] if args.ignore_paper_status else [],
                        payload=payload)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)

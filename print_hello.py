#!/usr/bin/env python3
"""Print one Hello, World! receipt to the connected SII RP-E10/E11.

Requires the system libusb-1.0 library. Run with sudo if USB access is denied.
"""

import argparse
import ctypes as C
import ctypes.util
import sys


VENDOR_ID = 0x0619
PRODUCT_ID = 0x0123
INTERFACE = 0
OUT_ENDPOINT = 0x01
PAYLOAD = b"\x1b@Hello, World!\n\n\n\n\n\x1dV\x01"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status-only", action="store_true",
                        help="Open the printer and read USB status without printing")
    parser.add_argument("--ignore-paper-status", action="store_true",
                        help="Allow printing with USB status bit 0x20 set; check paper first")
    args = parser.parse_args()
    usb = C.CDLL(ctypes.util.find_library("usb-1.0") or "libusb-1.0.so.0")
    signatures = {
        "init": ([C.POINTER(C.c_void_p)], C.c_int),
        "exit": ([C.c_void_p], None),
        "open_device_with_vid_pid": ([C.c_void_p, C.c_uint16, C.c_uint16], C.c_void_p),
        "close": ([C.c_void_p], None),
        "claim_interface": ([C.c_void_p, C.c_int], C.c_int),
        "release_interface": ([C.c_void_p, C.c_int], C.c_int),
        "control_transfer": ([C.c_void_p, C.c_uint8, C.c_uint8, C.c_uint16,
                              C.c_uint16, C.c_void_p, C.c_uint16, C.c_uint], C.c_int),
        "bulk_transfer": ([C.c_void_p, C.c_ubyte, C.c_void_p, C.c_int,
                           C.POINTER(C.c_int), C.c_uint], C.c_int),
        "error_name": ([C.c_int], C.c_char_p),
    }
    for name, (argtypes, result) in signatures.items():
        function = getattr(usb, "libusb_" + name)
        function.argtypes, function.restype = argtypes, result

    def check(result):
        if result < 0:
            raise RuntimeError(usb.libusb_error_name(result).decode())
        return result

    context = C.c_void_p()
    check(usb.libusb_init(C.byref(context)))
    handle = None
    claimed = False
    try:
        handle = usb.libusb_open_device_with_vid_pid(context, VENDOR_ID, PRODUCT_ID)
        if not handle:
            raise RuntimeError("Cannot open SII 0619:0123; check power, USB connection, "
                               "and permissions (udev rule or sudo)")
        check(usb.libusb_claim_interface(handle, INTERFACE))
        claimed = True
        print("Connected to SII 0619:0123, interface 0", flush=True)

        # USB Printer Class GET_PORT_STATUS. On this printer, bit 0x20 was
        # observed even while printing worked and the LED flashed blue.
        # Do not equate this bit alone with confirmed absence of paper.
        status = C.c_ubyte()
        result = usb.libusb_control_transfer(handle, 0xA1, 1, 0, 0,
                                             C.byref(status), 1, 2000)
        if result == 1:
            print(f"USB printer status: 0x{status.value:02x}", flush=True)
            if args.status_only:
                return
            if not status.value & 0x08:
                raise RuntimeError("Printer reports an error; no print sent")
            if status.value & 0x20 and not args.ignore_paper_status:
                raise RuntimeError("USB paper-status bit 0x20 is set; no print sent. "
                                   "This does not confirm paper empty on this model. "
                                   "Check paper, then use --ignore-paper-status to print")
        elif result == -9:  # LIBUSB_ERROR_PIPE: GET_PORT_STATUS unsupported/stalled.
            print("USB printer status unavailable (request stalled)", flush=True)
            if args.status_only:
                raise RuntimeError("Connected, but could not read USB printer status")
        else:
            check(result)
            raise RuntimeError(f"Unexpected USB status response length: {result}")

        # Initialize, ASCII text, feed to the cutter, then partial cut.
        data = C.create_string_buffer(PAYLOAD)
        transferred = C.c_int()
        result = usb.libusb_bulk_transfer(handle, OUT_ENDPOINT, data, len(PAYLOAD),
                                         C.byref(transferred), 5000)
        print(f"USB accepted {transferred.value}/{len(PAYLOAD)} bytes", flush=True)
        check(result)
        if transferred.value != len(PAYLOAD):
            raise RuntimeError("Incomplete transfer; inspect receipt before retrying")
        print("Print data sent; check the physical receipt.", flush=True)
    finally:
        if claimed:
            usb.libusb_release_interface(handle, INTERFACE)
        if handle:
            usb.libusb_close(handle)
        usb.libusb_exit(context)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)

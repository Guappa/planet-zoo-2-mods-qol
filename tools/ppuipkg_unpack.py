"""Unpack a cobra-tools .ppuipkg XML dump (Gameface UI package) into real files.

usage: python ppuipkg_unpack.py <file.ppuipkg> <out_dir>
"""
import os
import sys
import xml.etree.ElementTree as ET


def unpack(pkg_path, out_dir):
    count = 0
    name = None
    for event, elem in ET.iterparse(pkg_path, events=("end",)):
        if elem.tag == "file_name":
            name = elem.text
        elif elem.tag == "file_content":
            data = bytes(int(b) & 0xFF for b in elem.text.split()) if elem.text else b""
            path = os.path.normpath(os.path.join(out_dir, name))
            if not path.startswith(os.path.normpath(out_dir)):
                raise ValueError(f"unsafe path in package: {name}")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
            count += 1
        elif elem.tag == "ppuipkgfile":
            elem.clear()
    return count


if __name__ == "__main__":
    print(unpack(sys.argv[1], sys.argv[2]), "files")

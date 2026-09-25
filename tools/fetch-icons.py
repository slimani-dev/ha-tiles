#!/usr/bin/env python3
"""Download the default Material Design Icons into icons/mdi as GNOME symbolic icons.

The icon list is read from DEFAULT_ICONS in lib/entities.js, so it stays in
sync with the icons the extension can pick without a custom Home Assistant icon.
Any other icon is downloaded at runtime and cached.
"""
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MDI_VERSION = re.search(r"MDI_VERSION = '([^']+)'", (ROOT / "lib/icons.js").read_text()).group(1)
CDN = f"https://cdn.jsdelivr.net/npm/@mdi/svg@{MDI_VERSION}/svg"


def default_icons():
    js = (ROOT / "lib/entities.js").read_text()
    names = set()
    # Literal names inside DEFAULT_ICONS plus every quoted icon in the maps it spreads
    block = js[js.index("export const DEFAULT_ICONS"):]
    block = block[:block.index("];")]
    names.update(re.findall(r"'([a-z0-9-]+)'", block))
    for table in ("COVER_ICONS", "SENSOR_ICONS", "BINARY_SENSOR_ICONS"):
        body = js[js.index(f"const {table}"):]
        body = body[:body.index("};")]
        names.update(re.findall(r"'([a-z0-9-]+)'", body))
    names.update(f"battery-{n}" for n in range(10, 100, 10))
    return sorted(names)


def main():
    out = ROOT / "icons/mdi"
    out.mkdir(parents=True, exist_ok=True)
    failed = []
    for name in default_icons():
        target = out / f"{name}-symbolic.svg"
        if target.exists():
            continue
        try:
            with urllib.request.urlopen(f"{CDN}/{name}.svg", timeout=15) as r:
                svg = r.read().decode()
            if not svg.lstrip().startswith("<svg"):
                raise ValueError("not an SVG")
            target.write_text(svg)
        except Exception as e:  # noqa: BLE001 - report and continue
            failed.append(f"{name}: {e}")
    print(f"{len(list(out.glob('*.svg')))} icons in {out}")
    if failed:
        print("Failed:\n  " + "\n  ".join(failed), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

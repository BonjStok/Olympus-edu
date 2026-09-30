#!/usr/bin/env python3
"""Builds the static Inter fonts used by the deck from the variable Inter 4.1 font.

    python3 presentation/scripts/fonts.py path/to/InterVariable.woff2

Chromium prints variable fonts into PDF as Type3 glyph drawings; static instances are
embedded as regular TrueType fonts and look crisper in every PDF viewer. Output goes to
presentation/assets/fonts: Inter-{400,500,600,700} (opsz 14) for text and
InterDisplay-{600,700,800} (opsz 32) for headlines, subset to Latin and Cyrillic.
Requires fontTools and brotli (pip install fonttools brotli).
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "fonts")
SPECS = [("Inter", 14, [400, 500, 600, 700]), ("InterDisplay", 32, [600, 700, 800])]
UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+0400-045F,"
    "U+0490-0491,U+2000-206F,U+20AC,U+20BD,U+2116,U+2122,U+2190-2199,U+2212,U+2215,"
    "U+2248,U+2260,U+2264-2265,U+00D7,U+00F7,U+2713,U+2714,U+25CF"
)
FEATURES = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk", "tnum", "case", "frac", "sups"]


def main(source):
    for family, opsz, weights in SPECS:
        for weight in weights:
            font = instancer.instantiateVariableFont(TTFont(source), {"wght": weight, "opsz": opsz})
            options = subset.Options()
            options.flavor = "woff2"
            options.layout_features = FEATURES
            options.name_IDs = ["*"]
            options.notdef_outline = True
            options.hinting = False
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
            subsetter.subset(font)
            font.flavor = "woff2"
            path = os.path.join(OUT, f"{family}-{weight}.woff2")
            font.save(path)
            print(path, os.path.getsize(path))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

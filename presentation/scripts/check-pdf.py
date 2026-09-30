#!/usr/bin/env python3
"""Inspects the built deck PDF.

    python3 check-pdf.py dist/olympus-presentation.pdf [--previews DIR]

Checks: every page is 1440x810 pt; all fonts are embedded; every vector fill and
stroke is fully opaque (blurred CSS shadows and semi-transparent fills show up in
PDF viewers as grey boxes, so the deck must not contain any). With --previews it
also renders small JPEG previews (960 px wide) for a visual review.

Exit codes: 0 ok, 1 problems found, 3 PyMuPDF is not installed.
"""
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit(3)


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: check-pdf.py file.pdf [--previews DIR]")
        return 2
    pdf = args[0]
    previews = args[args.index("--previews") + 1] if "--previews" in args else None
    doc = fitz.open(pdf)
    problems = []

    for number, page in enumerate(doc, start=1):
        w, h = page.rect.width, page.rect.height
        if abs(w - 1440) > 0.5 or abs(h - 810) > 0.5:
            problems.append(f"page {number}: size {w:.1f}x{h:.1f} pt, expected 1440x810")
        for font in page.get_fonts():
            if font[2] == "Type3":
                problems.append(f"page {number}: Type3 font (a variable or missing font was printed)")
            elif font[1] == "n/a":
                problems.append(f"page {number}: font {font[3]} is not embedded")
        for d in page.get_drawings():
            fill = d.get("fill_opacity")
            stroke = d.get("stroke_opacity")
            if (fill is not None and fill < 0.999) or (stroke is not None and stroke < 0.999):
                r = d["rect"]
                problems.append(
                    f"page {number}: semi-transparent shape at "
                    f"{r.x0:.0f},{r.y0:.0f} {r.width:.0f}x{r.height:.0f} pt"
                )
        if previews:
            os.makedirs(previews, exist_ok=True)
            zoom = 960 / w
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            pix.save(os.path.join(previews, f"page-{number:02d}.jpg"), jpg_quality=62)

    print(f"• PDF: {len(doc)} pages, {os.path.getsize(pdf) / 1e6:.1f} MB")
    if problems:
        print(f"  ✗ PDF check ({len(problems)}):")
        for p in problems[:40]:
            print(f"    - {p}")
        return 1
    print("• PDF check: sizes, fonts and opacity are fine")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Baseline PDF -> XLSX converter using pdfplumber.  Usage: plumber_xlsx.py in.pdf out.xlsx

Every page, top to bottom, into ONE sheet: the page's ruled tables (pdfplumber's default
'lines' strategy) as rows; a page with no detected table falls back to its text lines, one
line per row in column A.  Cell newlines become spaces; cells that fully parse as numbers
('1,250.00', '(12.50)', '5.0%') are written as numbers.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl  # noqa: E402
import pdfplumber  # noqa: E402

from evalcore import parse_number  # noqa: E402


def conv(v):
    if v is None:
        return None
    s = " ".join(str(v).split())
    if not s:
        return None
    n = parse_number(s)
    return n if n is not None else s


def main():
    src, dst = sys.argv[1], sys.argv[2]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "PDF"
    with pdfplumber.open(src) as pdf:
        for page in pdf.pages:
            tables = sorted(page.find_tables(), key=lambda t: t.bbox[1])
            if tables:
                for t in tables:
                    for row in t.extract():
                        ws.append([conv(c) for c in row])
            else:
                for ln in page.extract_text_lines():
                    ws.append([conv(ln["text"])])
    wb.save(dst)


if __name__ == "__main__":
    main()

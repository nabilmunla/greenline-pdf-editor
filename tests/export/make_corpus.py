#!/usr/bin/env python3
"""Generate the PDF -> XLSX / DOCX evaluation corpus.

    python3 tests/export/make_corpus.py [--only PATTERN] [--no-scan]

Writes tests/export/corpus/<case>.pdf, <case>.truth.json and the generating
<case>.xlsx / <case>.docx (reportlab cases have no source document).  Everything is
seeded, so re-running gives the same content (PDF timestamps aside).

Case groups:  boq_*  spreadsheet BOQs (openpyxl -> LibreOffice -> PDF)
              tbl_*  other spreadsheet tables (door schedule, payments, comparison)
              qs_*   BOQs drawn directly with reportlab, mimicking QS-software printouts
              doc_*  Word documents (python-docx -> LibreOffice -> PDF)
              scan_* rasterised, rotated, noisy, stamped copies of other cases (image-only PDFs)
"""
import argparse
import datetime as dt
import fnmatch
import io
import json
import os
import random
import re
import shutil
import sys
import tempfile
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

import docxread  # noqa: E402
import evalcore  # noqa: E402
from corpus_text import *  # noqa: E402,F401,F403
import corpus_text as T  # noqa: E402

CORPUS = os.path.join(HERE, "corpus")


def rng_for(name):
    return random.Random(zlib.crc32(name.encode()) ^ 0x5EED)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


# ======================================================================
#  BOQ content
# ======================================================================

LETTERS = [c for c in "ABCDEFGHJKLMNPQRSTUVWXYZ"]  # I and O skipped, as in UK/UAE BOQs


def letter_ref(k):
    if k < len(LETTERS):
        return LETTERS[k]
    return LETTERS[k // len(LETTERS) - 1] + LETTERS[k % len(LETTERS)]


def make_qty(rng, unit, qmin, qmax):
    if qmin is None:
        return None
    if unit in ("nr", "No"):
        return rng.randint(int(qmin), int(qmax))
    if unit == "kg":
        return rng.randint(int(qmin / 10), int(qmax / 10)) * 10
    v = rng.uniform(qmin, qmax)
    return round(v, 2) if rng.random() < 0.7 else float(round(v))


def gen_section_items(rng, sec, priced, extras=0.35, max_items=None, desc_suffix=""):
    """Abstract item records for one BOQ section (no refs yet)."""
    out = []
    entries = T.BOQ_LIB[sec]
    real = [e for e in entries if not isinstance(e, str)]
    keep = set(range(len(real)))
    if max_items and len(real) > max_items:
        keep = set(sorted(rng.sample(range(len(real)), max_items)))
    pending_sub = None
    k = -1
    for e in entries:
        if isinstance(e, str):
            pending_sub = e[1:]
            continue
        k += 1
        if k not in keep:
            continue
        if pending_sub:
            out.append({"role": "subsection", "desc": pending_sub})
            pending_sub = None
        desc, unit, qmin, qmax, rmin, rmax = e
        if (rng.random() < extras and not desc.startswith("Ditto") and not desc.startswith("Rate only")
                and unit not in ("Sum",)):
            desc += rng.choice(T.EXTRA_CLAUSES).format(sec=rng.choice(T.SPEC_SECTIONS),
                                                       dwg=rng.choice(T.DRAWINGS))
        if desc_suffix and not desc.startswith("Ditto"):
            desc += desc_suffix
        qty = make_qty(rng, unit, qmin, qmax)
        rate = amount = None
        lump = unit in ("Item", "LS", "Sum")
        if priced:
            if lump:
                amount = float(round(rng.uniform(rmin, rmax), -2))
            else:
                rate = round(rng.uniform(rmin, rmax), 2)
                if qty is not None:
                    amount = round(qty * rate, 2)
        out.append({"role": "item", "desc": desc, "unit": unit, "qty": qty, "rate": rate,
                    "amount": amount})
    return out


def assign_refs(recs, style, start=1, prefix="", restart_on=("section", "page_start")):
    """style: letters (restart at every section / page marker), dotted 'p.n', numbers."""
    k = 0
    n = start
    for r in recs:
        if r["role"] in restart_on:
            if style == "letters":
                k = 0
        if r["role"] in ("section", "page_start"):
            continue
        if r["role"] != "item":
            continue
        if style == "letters":
            r["ref"] = letter_ref(k)
            k += 1
        elif style == "dotted":
            r["ref"] = "%s.%d" % (prefix, n)
            n += 1
        else:
            r["ref"] = str(n)
            n += 1
    return recs


def section_total(recs, label="Total Carried to Collection"):
    amts = [r.get("amount") for r in recs if r["role"] == "item" and r.get("amount") is not None]
    return {"role": "total", "desc": label, "amount": round(sum(amts), 2) if amts else None}


# ======================================================================
#  XLSX writer
# ======================================================================

def est_lines(text, width_chars, font_size):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    avail = (width_chars * 7 + 5) * 0.75 - 6
    sp = stringWidth(" ", "Helvetica", font_size)
    lines, cur = 1, 0.0
    for w in str(text).split():
        ww = stringWidth(w, "Helvetica", font_size)
        if cur == 0:
            cur = ww
        elif cur + sp + ww <= avail:
            cur += sp + ww
        else:
            lines += 1
            cur = ww
    return lines


def write_sheet(ws, sh):
    """Write one sheet from a spec and return its ground-truth dict.

    sh keys: cols [{key, width, fmt, h}], title_rows [str], header [[..]], header_merges
    [(r0,c0,r1,c1)] (0-based, relative to the header block), body [{role, cells or record}],
    borders all|vertical|none, valign, font_size, orientation, hdr (l,c,r), ftr (l,c,r),
    header_fill, body_merges [(r0,c0,r1,c1)] relative to body, fills {(body_row, col): hex}.
    """
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.pagebreak import Break

    cols = sh["cols"]
    ncol = len(cols)
    fs = sh.get("font_size", 9)
    desc_col = next((i for i, c in enumerate(cols) if c["key"] == "desc"), 1)
    thin = Side(style="thin")
    borders = sh.get("borders", "all")
    valign = sh.get("valign", "bottom")
    grid, types, roles, lines = [], [], [], []

    def cell_type(v, c):
        if v is None or v == "":
            return "e"
        if isinstance(v, (dt.date, dt.datetime)):
            return "d"
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return "p" if "%" in (c.get("fmt") or "") else "n"
        return "s"

    def truth_val(v):
        if isinstance(v, dt.datetime):
            return v.date().isoformat()
        if isinstance(v, dt.date):
            return v.isoformat()
        if v == "":
            return None
        return v

    for i, c in enumerate(cols):
        ws.column_dimensions[get_column_letter(i + 1)].width = c["width"]

    r = 1
    for t in sh.get("title_rows", []):
        cell = ws.cell(r, desc_col + 1, t)
        cell.font = Font(name="Arial", size=fs + 2, bold=True)
        row = [None] * ncol
        row[desc_col] = t
        grid.append(row); types.append(["e" if v is None else "s" for v in row]); roles.append("title")
        lines.append(1)
        r += 1
    if sh.get("title_rows"):
        grid.append([None] * ncol); types.append(["e"] * ncol); roles.append("blank"); lines.append(1)
        r += 1

    hdr_start = r
    header_rows = []
    fill = PatternFill("solid", fgColor=sh["header_fill"]) if sh.get("header_fill") else None
    for hrow in sh["header"]:
        for ci, v in enumerate(hrow):
            cell = ws.cell(r, ci + 1, v if v != "" else None)
            cell.font = Font(name="Arial", size=fs, bold=True)
            cell.alignment = Alignment(horizontal="center", vertical="top", wrap_text=True)
            if borders != "none":
                cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            if fill:
                cell.fill = fill
        header_rows.append(len(grid))
        grid.append([v if v != "" else None for v in hrow])
        types.append(["e" if v in (None, "") else "s" for v in hrow])
        roles.append("header")
        lines.append(1)
        r += 1
    for (r0, c0, r1, c1) in sh.get("header_merges", []):
        ws.merge_cells(start_row=hdr_start + r0, start_column=c0 + 1, end_row=hdr_start + r1,
                       end_column=c1 + 1)
    hdr_end = r - 1

    body_start = r
    breaks = []
    body = sh["body"]
    for bi, rec in enumerate(body):
        role = rec["role"]
        if "cells" in rec:
            vals = list(rec["cells"])
        else:
            vals = [rec.get(c["key"]) for c in cols]
        fmts = rec.get("fmts", {})
        for ci, v in enumerate(vals):
            c = cols[ci]
            cell = ws.cell(r, ci + 1, v)
            bold = role in ("section", "subsection", "total", "grand_total") or rec.get("bold")
            underline = "single" if role == "section" and ci == desc_col else None
            cell.font = Font(name="Arial", size=fs, bold=bool(bold and (v is not None)),
                             underline=underline)
            h = c.get("h", "left")
            wrap = c["key"] in ("desc", "remarks", "location") or c.get("wrap", False)
            va = rec.get("valign", valign)
            cell.alignment = Alignment(horizontal=h, vertical=va, wrap_text=wrap)
            fmt = fmts.get(ci, c.get("fmt"))
            if fmt and v is not None and not isinstance(v, str):
                cell.number_format = fmt
            if borders == "all":
                cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            elif borders == "vertical":
                last = bi == len(body) - 1
                cell.border = Border(left=thin, right=thin, bottom=thin if last else None)
            fx = sh.get("fills", {}).get((bi, ci))
            if fx:
                cell.fill = PatternFill("solid", fgColor=fx)
        grid.append([truth_val(v) for v in vals])
        types.append([cell_type(v, cols[ci]) for ci, v in enumerate(vals)])
        roles.append(role)
        dtext = vals[desc_col] if desc_col < len(vals) else None
        lines.append(est_lines(dtext, cols[desc_col]["width"], fs) if (role == "item" and dtext) else 1)
        if rec.get("break_after"):
            breaks.append(r)
        r += 1
    for (r0, c0, r1, c1) in sh.get("body_merges", []):
        ws.merge_cells(start_row=body_start + r0, start_column=c0 + 1, end_row=body_start + r1,
                       end_column=c1 + 1)
    for b in breaks:
        ws.row_breaks.append(Break(id=b))

    # print setup
    ws.print_title_rows = "%d:%d" % (hdr_start, hdr_end)
    ps = ws.page_setup
    ps.orientation = sh.get("orientation", "portrait")
    ps.paperSize = ws.PAPERSIZE_A4
    if sh.get("fit_width", True):
        ps.fitToWidth = 1
        ps.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_margins.left = ws.page_margins.right = 0.45
    ws.page_margins.top = ws.page_margins.bottom = 0.8
    ws.page_margins.header = ws.page_margins.footer = 0.3
    hl, hc, hr = sh.get("hdr", ("", "", ""))
    fl, fc, fr = sh.get("ftr", ("", "", ""))
    for part, txt in ((ws.oddHeader.left, hl), (ws.oddHeader.center, hc), (ws.oddHeader.right, hr),
                      (ws.oddFooter.left, fl), (ws.oddFooter.center, fc), (ws.oddFooter.right, fr)):
        if txt:
            part.text = txt
            part.size = 8
            part.font = "Arial,Regular"
    furniture = [re.sub(r"&[PN]", "#", t) for t in (hl, hc, hr, fl, fc, fr) if t]
    return {
        "name": ws.title,
        "columns": [c["key"] for c in cols],
        "rows": grid,
        "types": types,
        "roles": roles,
        "lines": lines,
        "header_rows": header_rows,
        "repeat_rows": list(range(hdr_start - 1, hdr_end)),
        "page_furniture": furniture,
    }


BOQ_COLS = [
    {"key": "ref", "width": 6, "h": "center"},
    {"key": "desc", "width": 52},
    {"key": "qty", "width": 11, "fmt": "#,##0.00", "h": "right"},
    {"key": "unit", "width": 7, "h": "center"},
    {"key": "rate", "width": 11, "fmt": "#,##0.00", "h": "right"},
    {"key": "amount", "width": 14, "fmt": "#,##0.00", "h": "right"},
]


def int_fmts(recs, cols):
    """Integer quantities (nr/No/kg) shown without decimals."""
    qi = next(i for i, c in enumerate(cols) if c["key"] == "qty")
    for r in recs:
        if r.get("role") == "item" and r.get("unit") in ("nr", "No", "kg"):
            r.setdefault("fmts", {})[qi] = "#,##0"
    return recs


def boq_bill(rng, sections, *, ref_style, priced, prefix="", zones=None, max_items=None, extras=0.35):
    recs = []
    zones = zones or [None]
    for z in zones:
        for si, sec in enumerate(sections):
            p = priced if priced in (True, False) else (si % 2 == 0)
            items = gen_section_items(rng, sec, p, extras=extras, max_items=max_items)
            title = sec if z is None else "%s - %s" % (z, sec)
            recs.append({"role": "section", "desc": title})
            recs.extend(items)
            recs.append(section_total(items))
    assign_refs(recs, ref_style, prefix=prefix)
    return recs


def save_wb(wb, path):
    wb.save(path)


def case_xlsx(name, group, descr, sheets_fn):
    """Helper: build workbook via sheets_fn(wb, rng) -> list of truth sheets."""
    from openpyxl import Workbook
    rng = rng_for(name)
    wb = Workbook()
    wb.remove(wb.active)
    sheets = sheets_fn(wb, rng)
    path = os.path.join(CORPUS, name + ".xlsx")
    save_wb(wb, path)
    furn = []
    for s in sheets:
        for f in s.pop("page_furniture"):
            if f not in furn:
                furn.append(f)
    return {"case": name, "kind": "xlsx", "group": group, "source": "xlsx", "scanned": False,
            "description": descr, "page_furniture": furn, "sheets": sheets, "_src": path}


HDR_STD = ["ITEM", "DESCRIPTION", "QTY", "UNIT", "RATE (AED)", "AMOUNT (AED)"]


def build_boq_allborders():
    def fn(wb, rng):
        recs = boq_bill(rng, ["EXCAVATION AND EARTHWORK", "CONCRETE WORK", "WATERPROOFING"],
                        ref_style="letters", priced=True)
        ws = wb.create_sheet("Bill 2")
        return [write_sheet(ws, {
            "cols": BOQ_COLS, "title_rows": [T.PROJECT.upper(), "BILL No. 2 - SUBSTRUCTURE"],
            "header": [HDR_STD], "body": int_fmts(recs, BOQ_COLS), "borders": "all",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 2 - Substructure"),
            "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_allborders", "boq", "Priced BOQ, all cell borders, letter refs, A4 portrait", fn)


def build_boq_vlines():
    def fn(wb, rng):
        recs = boq_bill(rng, ["MASONRY", "PLASTERING AND PAINTING", "FLOOR AND WALL TILING", "CEILINGS"],
                        ref_style="dotted", prefix="4", priced=False, zones=["APARTMENTS", "COMMON AREAS", "RETAIL UNITS"])
        ws = wb.create_sheet("Bill 4")
        return [write_sheet(ws, {
            "cols": BOQ_COLS, "title_rows": [T.PROJECT.upper(), "BILL No. 4 - FINISHES"],
            "header": [["Ref.", "Description", "Qty", "Unit", "Rate AED", "Amount AED"]],
            "body": int_fmts(recs, BOQ_COLS), "borders": "vertical",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 4 - Finishes"),
            "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_vlines", "boq", "Unpriced BOQ, vertical borders only, refs 4.1..4.n (incl. 4.10), "
                     "multi-page", fn)


def build_boq_noborders():
    def fn(wb, rng):
        recs = boq_bill(rng, ["PRELIMINARIES", "PROVISIONAL SUMS", "EXTERNAL WORKS"], ref_style="letters",
                        priced="mixed")
        ws = wb.create_sheet("Bill 1")
        return [write_sheet(ws, {
            "cols": BOQ_COLS, "title_rows": [T.PROJECT.upper(), "BILL No. 1 - PRELIMINARIES AND GENERAL"],
            "header": [["Item", "Description", "Qty", "Unit", "Rate", "Amount"]],
            "body": int_fmts(recs, BOQ_COLS), "borders": "none", "valign": "top",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 1 - Preliminaries"),
            "ftr": ("", "Page &P of &N", "")})]
    return case_xlsx("boq_noborders", "boq", "BOQ with no borders at all, top-aligned (qty on first line), "
                     "partly priced, lump sums", fn)


def build_boq_landscape():
    cols = [
        {"key": "ref", "width": 6, "h": "center"},
        {"key": "desc", "width": 62},
        {"key": "spec", "width": 10, "h": "center"},
        {"key": "qty", "width": 11, "fmt": "#,##0.00", "h": "right"},
        {"key": "unit", "width": 7, "h": "center"},
        {"key": "rate", "width": 11, "fmt": "#,##0.00", "h": "right"},
        {"key": "amount", "width": 15, "fmt": "#,##0.00", "h": "right"},
        {"key": "remarks", "width": 24},
    ]
    remarks = ["Refer door schedule", "Provisional quantity", "As per approved sample", "Refer to drawing A-410",
               "Client supplied item", None, None, None]

    def fn(wb, rng):
        recs = boq_bill(rng, ["DOORS AND IRONMONGERY", "CEILINGS", "FLOOR AND WALL TILING", "MASONRY"],
                        ref_style="numbers", priced=True)
        for r in recs:
            if r["role"] == "item":
                r["spec"] = rng.choice(T.SPEC_SECTIONS)
                r["remarks"] = rng.choice(remarks)
        ws = wb.create_sheet("Bill 5")
        return [write_sheet(ws, {
            "cols": cols, "title_rows": [T.PROJECT.upper(), "BILL No. 5 - DOORS, CEILINGS AND FINISHES"],
            "header": [["No.", "Description", "Spec Ref", "Quantity", "Unit", "Rate", "Amount", "Remarks"]],
            "body": int_fmts(recs, cols), "borders": "vertical", "orientation": "landscape",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 5"), "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_landscape", "boq", "Landscape BOQ with spec-ref and remarks columns, numeric refs", fn)


def build_boq_negative():
    cols = [
        {"key": "ref", "width": 9, "h": "center"},
        {"key": "desc", "width": 50},
        {"key": "unit", "width": 7, "h": "center"},
        {"key": "qty", "width": 11, "fmt": "#,##0.00;(#,##0.00)", "h": "right"},
        {"key": "rate", "width": 11, "fmt": "#,##0.00", "h": "right"},
        {"key": "amount", "width": 15, "fmt": "#,##0.00;(#,##0.00)", "h": "right"},
    ]

    def fn(wb, rng):
        recs = []
        n = 1
        for title, sign, secs in (("A. OMISSIONS", -1, ["MASONRY", "PLASTERING AND PAINTING"]),
                                  ("B. ADDITIONS", 1, ["FLOOR AND WALL TILING", "CEILINGS"])):
            recs.append({"role": "section", "desc": title})
            items = []
            for sec in secs:
                for it in gen_section_items(rng, sec, True, extras=0.2, max_items=4):
                    if it["role"] != "item" or it["qty"] is None:
                        continue
                    it["qty"] = round(sign * it["qty"] * rng.uniform(0.05, 0.3), 2)
                    it["amount"] = round(it["qty"] * it["rate"], 2)
                    it["ref"] = "VO7/%02d" % n
                    n += 1
                    items.append(it)
            recs.extend(items)
            recs.append({"role": "total", "desc": "Total " + title.split(". ")[1].title(),
                         "amount": round(sum(i["amount"] for i in items), 2)})
        net = round(sum(r["amount"] for r in recs if r["role"] == "total"), 2)
        recs.append({"role": "grand_total", "desc": "NET ADDITION / (OMISSION) TO CONTRACT SUM", "amount": net})
        ws = wb.create_sheet("VO 07")
        return [write_sheet(ws, {
            "cols": cols, "title_rows": [T.PROJECT.upper(), "VARIATION ORDER No. 07 - OMISSIONS AND ADDITIONS"],
            "header": [["Ref.", "Description", "Unit", "Qty", "Rate", "Amount (AED)"]],
            "body": recs, "borders": "all",
            "hdr": (T.PROJECT_SHORT, "", "VO No. 07"), "ftr": ("", "Page &P of &N", "")})]
    return case_xlsx("boq_negative", "boq", "Variation statement with negative quantities/amounts shown in "
                     "parentheses", fn)


def build_boq_twolevel():
    cols = [
        {"key": "ref", "width": 6, "h": "center"},
        {"key": "desc", "width": 46},
        {"key": "qty", "width": 10, "fmt": "#,##0.00", "h": "right"},
        {"key": "unit", "width": 6, "h": "center"},
        {"key": "rate_l", "width": 10, "fmt": "#,##0.00", "h": "right"},
        {"key": "rate_m", "width": 10, "fmt": "#,##0.00", "h": "right"},
        {"key": "amount", "width": 14, "fmt": "#,##0.00", "h": "right"},
    ]

    def fn(wb, rng):
        recs = boq_bill(rng, ["CONCRETE WORK", "REINFORCEMENT AND FORMWORK", "WATERPROOFING"],
                        ref_style="letters", priced=True)
        for r in recs:
            if r["role"] == "item" and r.get("rate") is not None:
                lab = round(r["rate"] * rng.uniform(0.25, 0.45), 2)
                r["rate_l"], r["rate_m"] = lab, round(r["rate"] - lab, 2)
                if r["qty"] is not None:
                    r["amount"] = round(r["qty"] * (r["rate_l"] + r["rate_m"]), 2)
        for i, r in enumerate(recs):
            if r["role"] == "total":
                j = i - 1
                amts = []
                while j >= 0 and recs[j]["role"] != "section":
                    if recs[j]["role"] == "item" and recs[j].get("amount") is not None:
                        amts.append(recs[j]["amount"])
                    j -= 1
                r["amount"] = round(sum(amts), 2)
        ws = wb.create_sheet("Bill 3")
        return [write_sheet(ws, {
            "cols": cols, "title_rows": [T.PROJECT.upper(), "BILL No. 3 - SUPERSTRUCTURE"],
            "header": [["ITEM", "DESCRIPTION", "QTY", "UNIT", "RATE (AED)", "", "AMOUNT (AED)"],
                       ["", "", "", "", "Labour", "Material", ""]],
            "header_merges": [(0, 0, 1, 0), (0, 1, 1, 1), (0, 2, 1, 2), (0, 3, 1, 3), (0, 4, 0, 5),
                              (0, 6, 1, 6)],
            "body": int_fmts(recs, cols), "borders": "vertical", "header_fill": "EDEDED",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 3 - Superstructure"),
            "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_twolevel", "boq", "Two-level merged header (RATE over Labour | Material)", fn)


def build_boq_long():
    def fn(wb, rng):
        zones = ["BASEMENT B2", "BASEMENT B1", "GROUND FLOOR", "PODIUM", "TYPICAL FLOORS 1-12", "ROOF"]
        secs = ["CONCRETE WORK", "REINFORCEMENT AND FORMWORK", "WATERPROOFING", "MASONRY",
                "PLASTERING AND PAINTING"]
        items = []
        for z in zones:
            for sec in secs:
                if z == "ROOF" and sec == "MASONRY":
                    continue
                its = gen_section_items(rng, sec, True, extras=0.3, max_items=4)
                items.append({"role": "section", "desc": "%s - %s" % (z, sec)})
                items.extend(its)
        # paginate: ~38 estimated description lines per page, letters restart per page
        recs, page, budget, used, page_totals = [], [], 38, 0, []
        width = BOQ_COLS[1]["width"]

        def flush():
            tot = section_total(page)
            tot["break_after"] = True
            page_totals.append(tot["amount"] or 0.0)
            recs.append({"role": "page_start"})
            recs.extend(page)
            recs.append(tot)

        for it in items:
            h = est_lines(it["desc"], width, 9) + (1 if it["role"] == "section" else 0)
            if used + h > budget and page:
                if page[-1]["role"] in ("section", "subsection"):
                    carry = [page.pop()]
                else:
                    carry = []
                flush()
                page, used = carry, sum(est_lines(c["desc"], width, 9) for c in carry)
            page.append(it)
            used += h
        flush()
        assign_refs(recs, "letters", restart_on=("page_start",))
        recs = [r for r in recs if r["role"] != "page_start"]
        recs.append({"role": "section", "desc": "COLLECTION"})
        for p, amt in enumerate(page_totals, 1):
            recs.append({"role": "collection", "desc": "Page No. 2/%d" % p, "amount": round(amt, 2)})
        recs.append({"role": "grand_total", "desc": "TOTAL OF BILL No. 2 CARRIED TO GRAND SUMMARY",
                     "amount": round(sum(page_totals), 2)})
        ws = wb.create_sheet("Bill 2")
        return [write_sheet(ws, {
            "cols": BOQ_COLS, "title_rows": [T.PROJECT.upper(), "BILL No. 2 - STRUCTURE AND ENVELOPE"],
            "header": [HDR_STD], "body": int_fmts(recs, BOQ_COLS), "borders": "vertical",
            "hdr": (T.PROJECT_SHORT, "", "Bill No. 2 - Structure and Envelope"),
            "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_long", "boq", "Long priced BOQ (11 pages), manual page breaks, letters restart per "
                     "page, page totals and collection page, header row repeated", fn)


def build_boq_twobills():
    def fn(wb, rng):
        out = []
        for no, title, secs, priced, style in (
                (3, "SUPERSTRUCTURE", ["CONCRETE WORK", "MASONRY"], True, "letters"),
                (4, "FINISHES", ["PLASTERING AND PAINTING", "FLOOR AND WALL TILING", "CEILINGS"], False,
                 "letters")):
            recs = boq_bill(rng, secs, ref_style=style, priced=priced)
            ws = wb.create_sheet("Bill %d" % no)
            out.append(write_sheet(ws, {
                "cols": BOQ_COLS, "title_rows": [T.PROJECT.upper(), "BILL No. %d - %s" % (no, title)],
                "header": [HDR_STD], "body": int_fmts(recs, BOQ_COLS), "borders": "vertical",
                "hdr": (T.PROJECT_SHORT, "", "Bill No. %d - %s" % (no, title.title())),
                "ftr": (T.TENDER_REF, "Page &P of &N", "")}))
        return out
    return case_xlsx("boq_twobills", "boq", "Workbook with two bills (two sheets) printed as one PDF", fn)


def build_boq_summary():
    cols = [{"key": "ref", "width": 9, "h": "center"}, {"key": "desc", "width": 52},
            {"key": "pct", "width": 10, "fmt": "0.0%", "h": "right"},
            {"key": "amount", "width": 20, "fmt": "#,##0.00", "h": "right"}]
    bills = ["Preliminaries and General", "Substructure", "Superstructure", "Finishes",
             "Doors, Windows and Ironmongery", "Mechanical Services (Provisional)",
             "Electrical Services (Provisional)", "External Works", "Provisional Sums and Daywork"]

    def fn(wb, rng):
        amts = [float(round(rng.uniform(2.5e6, 4.5e7), 2)) for _ in bills]
        sub = round(sum(amts), 2)
        recs = [{"role": "section", "desc": "SUMMARY OF BILLS"}]
        for k, (b, a) in enumerate(zip(bills, amts), 1):
            recs.append({"role": "item", "ref": "Bill %d" % k, "desc": b, "pct": round(a / sub, 3),
                         "amount": a})
        cont = round(sub * 0.05, 2)
        excl = round(sub + cont, 2)
        vat = round(excl * 0.05, 2)
        recs += [{"role": "total", "desc": "SUB-TOTAL", "pct": 1.0, "amount": sub},
                 {"role": "item", "desc": "Add: Contingency", "pct": 0.05, "amount": cont},
                 {"role": "total", "desc": "TOTAL EXCLUDING VAT", "amount": excl},
                 {"role": "item", "desc": "Add: Value Added Tax", "pct": 0.05, "amount": vat},
                 {"role": "grand_total", "desc": "GRAND TOTAL CARRIED TO FORM OF TENDER",
                  "amount": round(excl + vat, 2)},
                 {"role": "item", "desc": "Tenderer's signature and company stamp: ____________________"}]
        ws = wb.create_sheet("Grand Summary")
        return [write_sheet(ws, {
            "cols": cols, "title_rows": [T.PROJECT.upper(), "GRAND SUMMARY"],
            "header": [["BILL", "DESCRIPTION", "% OF TOTAL", "AMOUNT (AED)"]], "body": recs, "borders": "all",
            "header_fill": "D9D9D9", "valign": "center",
            "hdr": (T.PROJECT_SHORT, "", "Grand Summary"), "ftr": (T.TENDER_REF, "Page &P of &N", "")})]
    return case_xlsx("boq_summary", "boq", "Grand Summary: bill totals with % share, contingency and VAT lines, "
                     "large AED amounts", fn)


def build_tbl_doors():
    cols = [{"key": "door", "width": 8, "h": "center"}, {"key": "location", "width": 16},
            {"key": "type", "width": 6, "h": "center"}, {"key": "w", "width": 6, "h": "center", "fmt": "0"},
            {"key": "h", "width": 6, "h": "center", "fmt": "0"}, {"key": "leaf_mat", "width": 12},
            {"key": "leaf_fin", "width": 12}, {"key": "frame_mat", "width": 11},
            {"key": "frame_fin", "width": 11}, {"key": "fire", "width": 7, "h": "center"},
            {"key": "iron", "width": 9, "h": "center"}, {"key": "vp", "width": 7, "h": "center"},
            {"key": "qty", "width": 5, "h": "center", "fmt": "0"}, {"key": "remarks", "width": 22}]
    types = {
        "D1": (900, 2100, "Solid core timber", "Oak veneer", "Hardwood", "Stained", "-", "IR-01", "No"),
        "D2": (800, 2100, "Solid core timber", "Paint grade", "Hardwood", "Painted", "-", "IR-02", "No"),
        "FD1": (1000, 2100, "Fire rated timber", "Oak veneer", "Hardwood", "Stained", "60 min", "IR-03", "Yes"),
        "FD2": (1800, 2400, "Fire rated timber", "HPL", "Steel", "Powder coated", "60 min", "IR-04", "Yes"),
        "SD1": (1000, 2100, "Steel, louvred", "Powder coated", "Steel", "Powder coated", "-", "IR-05", "No"),
        "FS1": (1200, 2100, "Steel, insulated", "Powder coated", "Steel", "Powder coated", "120 min", "IR-06",
                "Yes"),
    }

    def fn(wb, rng):
        recs, merges, n = [], [], 0
        for lvl, code, pool in (("BASEMENT LEVELS B2 / B1", "B", ["SD1", "FS1", "FD2", "D2"]),
                                ("GROUND FLOOR", "G", ["FD2", "FD1", "D1", "SD1"]),
                                ("TYPICAL FLOOR (LEVELS 1-12)", "T", ["D1", "D2", "FD1", "D2", "D1"])):
            recs.append({"role": "section", "cells": [lvl] + [None] * (len(cols) - 1)})
            merges.append((len(recs) - 1, 0, len(recs) - 1, len(cols) - 1))
            k = 0
            nd = 22 if code == "T" else 15
            while k < nd:
                ty = rng.choice(pool)
                run = rng.choice([1, 1, 2, 3])
                remark = rng.choice(["Refer to detail 3/A-601", "Door closer and hold-open device",
                                     "Coordinate with access control", "Undercut 10mm for ventilation"])
                start = len(recs)
                for j in range(min(run, nd - k)):
                    w, h, lm, lf, fm, ff, fire, iron, vp = types[ty]
                    k += 1
                    n += 1
                    recs.append({"role": "item", "cells": [
                        "%s-%03d" % (code, k), rng.choice(T.DOOR_LOCATIONS), ty, w, h, lm, lf, fm, ff, fire,
                        iron, vp, rng.choice([1, 1, 2, 12, 24]) if code == "T" else 1,
                        remark if j == 0 else None]})
                if len(recs) - start > 1:
                    merges.append((start, len(cols) - 1, len(recs) - 1, len(cols) - 1))
                    for rr in recs[start:]:
                        rr["valign"] = "top"
        ws = wb.create_sheet("Door Schedule")
        hdr1 = ["DOOR No.", "LOCATION", "TYPE", "SIZE (mm)", "", "LEAF", "", "FRAME", "", "FIRE RATING",
                "IRONM. SET", "VISION PANEL", "QTY", "REMARKS"]
        hdr2 = ["", "", "", "W", "H", "Material", "Finish", "Material", "Finish", "", "", "", "", ""]
        hm = [(0, c, 1, c) for c in (0, 1, 2, 9, 10, 11, 12, 13)] + [(0, 3, 0, 4), (0, 5, 0, 6), (0, 7, 0, 8)]
        return [write_sheet(ws, {
            "cols": cols, "title_rows": ["DOOR SCHEDULE - REVISION C"], "header": [hdr1, hdr2],
            "header_merges": hm, "body": recs, "body_merges": merges, "borders": "all", "font_size": 7,
            "orientation": "landscape", "header_fill": "D9D9D9",
            "hdr": (T.PROJECT_SHORT, "Door Schedule", "Rev. C"), "ftr": ("", "Page &P of &N", "")})]
    return case_xlsx("tbl_doors", "tbl", "Door schedule: 14 columns, 7pt font, shaded two-level merged header, "
                     "merged group rows and vertically merged remarks", fn)


def build_tbl_payments():
    cols = [{"key": "no", "width": 5, "h": "center"}, {"key": "desc", "width": 38},
            {"key": "due", "width": 13, "fmt": "dd-mmm-yyyy", "h": "center"},
            {"key": "cert", "width": 13, "fmt": "dd-mmm-yyyy", "h": "center"},
            {"key": "pct", "width": 10, "fmt": "0.0%", "h": "right"},
            {"key": "amount", "width": 19, "fmt": '"AED "#,##0.00', "h": "right"},
            {"key": "ret", "width": 15, "fmt": "#,##0.00;(#,##0.00)", "h": "right"},
            {"key": "net", "width": 19, "fmt": '"AED "#,##0.00', "h": "right"},
            {"key": "status", "width": 11, "h": "center"}]
    contract = 186450000.00

    def fn(wb, rng):
        recs = []
        d0 = dt.date(2026, 1, 15)
        pcts = [0.10] + [round(rng.uniform(0.03, 0.08), 3) for _ in range(13)]
        tot_a = tot_r = tot_n = 0.0
        for i, p in enumerate(pcts):
            due = d0 + dt.timedelta(days=30 * i + rng.randint(0, 4))
            done = i < 9
            amt = round(contract * p, 2)
            ret = 0.0 if i == 0 else round(-0.10 * amt, 2)
            net = round(amt + ret, 2)
            desc = "Advance Payment (against guarantee)" if i == 0 else "Interim Payment Certificate No. %d" % i
            recs.append({"role": "item", "cells": [
                str(i + 1), desc, due, due + dt.timedelta(days=rng.randint(10, 25)) if done else None, p, amt,
                ret if ret else None, net, "Paid" if done else "Pending"]})
            tot_a += amt
            tot_r += ret
            tot_n += net
        recs.append({"role": "total", "cells": [None, "TOTAL", None, None, round(sum(pcts), 3), round(tot_a, 2),
                                                round(tot_r, 2), round(tot_n, 2), None]})
        ws = wb.create_sheet("Payments")
        return [write_sheet(ws, {
            "cols": cols, "title_rows": ["SCHEDULE OF PAYMENTS", "Contract Sum: AED 186,450,000.00 (excl. VAT)"],
            "header": [["No.", "Payment Milestone", "Due Date", "Certified", "% of Contract", "Amount",
                        "Retention 10%", "Net Payable", "Status"]],
            "body": recs, "borders": "all", "orientation": "landscape", "header_fill": "DDEBF7",
            "hdr": (T.PROJECT_SHORT, "", "Payment Schedule"), "ftr": ("", "Page &P of &N", "")})]
    return case_xlsx("tbl_payments", "tbl", "Payment schedule with dates, percentages, AED currency format and "
                     "negative retention", fn)


def build_tbl_comparison():
    subs = ["Al Fajr Landscaping LLC", "Green Oasis Contracting", "Desert Bloom Tech. Services"]
    cols = [{"key": "ref", "width": 5, "h": "center"}, {"key": "desc", "width": 40},
            {"key": "unit", "width": 6, "h": "center"}, {"key": "qty", "width": 9, "fmt": "#,##0.00", "h": "right"}]
    for k in range(3):
        cols += [{"key": "r%d" % k, "width": 10, "fmt": "#,##0.00", "h": "right"},
                 {"key": "a%d" % k, "width": 13, "fmt": "#,##0.00", "h": "right"}]
    items = [("Topsoil, imported, 300mm thick, spread and levelled", "m3", 850, 95),
             ("Irrigation system complete with drip lines, controllers and valves", "m2", 4200, 38),
             ("Date palm (Phoenix dactylifera) 4.0m clear trunk, including planting and staking", "nr", 46, 2600),
             ("Ground cover planting at 9 nr/m2", "m2", 1650, 55),
             ("Natural stone paving 600x300x30mm on mortar bed", "m2", 1240, 210),
             ("Rubber safety flooring 40mm thick to play area", "m2", 380, 320),
             ("Swimming pool tiling, glass mosaic 25x25mm", "m2", 520, 285),
             ("Pool equipment: filtration, pumps and dosing, complete", "LS", None, 185000)]

    def fn(wb, rng):
        recs, fills = [], {}
        totals = [0.0, 0.0, 0.0]
        for i, (d, u, q, base) in enumerate(items):
            cells = [str(i + 1), d, u, float(q) if q else None]
            amts = []
            for k in range(3):
                rate = round(base * rng.uniform(0.85, 1.2), 2)
                amt = round((q or 1) * rate, 2)
                if q is None:
                    cells += [None, amt]
                else:
                    cells += [rate, amt]
                amts.append(amt)
                totals[k] += amt
            lo = int(np.argmin(amts))
            fills[(len(recs), 5 + 2 * lo)] = "C6EFCE"
            recs.append({"role": "item", "cells": cells})
        disc = [0.0, -0.025, -0.04]
        net = [round(t * (1 + d), 2) for t, d in zip(totals, disc)]
        lowest = min(net)
        recs.append({"role": "total", "cells": [None, "TOTAL", None, None] + sum(
            [[None, round(t, 2)] for t in totals], [])})
        recs.append({"role": "item", "cells": [None, "Discount offered", None, None] + sum(
            [[d if d else None, round(t * d, 2) if d else None] for t, d in zip(totals, disc)], [])})
        recs.append({"role": "total", "cells": [None, "NET TOTAL", None, None] + sum(
            [[None, n] for n in net], [])})
        recs.append({"role": "item", "cells": [None, "Variance from lowest", None, None] + sum(
            [[None, round(n / lowest - 1, 4)] for n in net], [])})
        recs.append({"role": "item", "cells": [None, "Payment terms", None, None, "30 days PDC", None,
                                               "45 days", None, "Back to back", None]})
        recs.append({"role": "item", "cells": [None, "Offer validity", None, None, "90 days", None, "60 days",
                                               None, "90 days", None]})
        fm = {}
        for k in range(3):
            fm[4 + 2 * k] = "0.0%"
        recs[-5]["fmts"] = dict(fm)
        recs[-3]["fmts"] = {5 + 2 * k: "0.00%" for k in range(3)}
        ws = wb.create_sheet("Comparison")
        hdr1 = ["Item", "Description", "Unit", "Qty"] + sum([[s, ""] for s in subs], [])
        hdr2 = ["", "", "", ""] + ["Rate", "Amount"] * 3
        hm = [(0, c, 1, c) for c in range(4)] + [(0, 4 + 2 * k, 0, 5 + 2 * k) for k in range(3)]
        sheet = write_sheet(ws, {
            "cols": cols, "title_rows": ["SUBCONTRACT QUOTATION COMPARISON - LANDSCAPING AND POOL PACKAGE"],
            "header": [hdr1, hdr2], "header_merges": hm, "body": recs, "borders": "all",
            "orientation": "landscape", "header_fill": "FFF2CC", "fills": fills,
            "hdr": (T.PROJECT_SHORT, "", "Comparison Sheet"), "ftr": ("", "Page &P of &N", "")})
        # percentage cells: mark type p (write_sheet only infers from column formats)
        for ri, role in enumerate(sheet["roles"]):
            row = sheet["rows"][ri]
            if row[1] in ("Discount offered", "Variance from lowest"):
                for ci in range(4, 10):
                    if isinstance(row[ci], float) and abs(row[ci]) < 1 and (
                            row[1] == "Variance from lowest" or ci % 2 == 0):
                        sheet["types"][ri][ci] = "p"
        return [sheet]
    return case_xlsx("tbl_comparison", "tbl", "Subcontractor quotation comparison: merged supplier headers, "
                     "highlighted lowest, discounts and variance percentages, text terms", fn)


# ======================================================================
#  reportlab QS-software style BOQs
# ======================================================================

def build_qs(name, *, qty_on, priced, bill_no, bill_title, secs, seed_extra=0, leaders=False, vlines=True,
             page_totals=False, font="Helvetica", ref_style="letters"):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas

    rng = rng_for(name)
    recs = []
    for sec in secs:
        items = gen_section_items(rng, sec, priced, extras=0.45, max_items=6)
        recs.append({"role": "section", "desc": sec})
        recs.extend(items)
    W, H = A4
    X = {"ref": (36, 66), "desc": (66, 330), "qty": (330, 392), "unit": (392, 428), "rate": (428, 488),
         "amount": (488, 560)}
    FS, LH = (8.5, 10.5) if font == "Courier" else (9, 11.2)
    FB = {"Helvetica": "Helvetica-Bold", "Courier": "Courier-Bold"}[font]
    FI = {"Helvetica": "Helvetica-Oblique", "Courier": "Courier-Oblique"}[font]
    top_rule, col_hdr_base, col_hdr_rule = 792, 780, 772
    foot_rule = 64
    body_top = col_hdr_rule - 12
    cf_y = foot_rule + 8
    path = os.path.join(CORPUS, name + ".pdf")
    c = canvas.Canvas(path, pagesize=A4, invariant=1)
    c.setTitle("Bill No. %d - %s" % (bill_no, bill_title.title()))

    def fmt(v):
        return "{:,.2f}".format(v)

    truth_rows, roles, lines_info = [], [], []
    hdr = ["Item", "Description", "Qty", "Unit", "Rate", "Amount"]
    truth_rows.append(hdr)
    roles.append("header")
    lines_info.append(1)
    page = [1]
    state = {"y": body_top, "sum": 0.0, "page_sum": 0.0, "letter": 0, "n": 0}

    def rjust(text, col, y, f=None):
        c.setFont(f or font, FS)
        c.drawRightString(X[col][1] - 4, y, text)

    def page_frame():
        c.setFont("Helvetica-Bold", 8)
        c.drawString(36, 812, T.PROJECT_SHORT.upper())
        c.drawRightString(560, 812, "BILL No. %d - %s" % (bill_no, bill_title))
        c.setLineWidth(0.8)
        c.line(36, top_rule, 560, top_rule)
        c.line(36, col_hdr_rule, 560, col_hdr_rule)
        c.line(36, foot_rule, 560, foot_rule)
        c.setLineWidth(0.5)
        if vlines:
            for k in ("ref", "desc", "qty", "unit", "rate", "amount"):
                c.line(X[k][0], top_rule, X[k][0], foot_rule)
            c.line(560, top_rule, 560, foot_rule)
        c.setFont(FB, FS)
        for k, t in zip(("ref", "desc", "qty", "unit", "rate", "amount"), hdr):
            x0, x1 = X[k]
            c.drawCentredString((x0 + x1) / 2, col_hdr_base, t)
        c.setFont("Helvetica", 8)
        c.drawString(36, 50, T.TENDER_REF)
        c.drawCentredString(W / 2, 50, "Page %d/%d" % (bill_no, page[0]))

    def carried():
        y = cf_y
        if page_totals:
            label, role, amt = "Total carried to Collection", "total", state["page_sum"]
            c.setFont(FB, FS)
        else:
            label, role, amt = "Carried forward", "cf", state["sum"]
            c.setFont(FI, FS)
        c.drawString(X["desc"][0] + 4, y, label)
        amt = round(amt, 2) if priced else None
        if priced:
            rjust(fmt(amt), "amount", y, FB if page_totals else None)
            c.line(X["amount"][0] + 4, y + LH - 1, X["amount"][1] - 4, y + LH - 1)
        truth_rows.append([None, label, None, None, None, amt])
        roles.append(role)
        lines_info.append(1)
        state["page_sum"] = 0.0

    def new_page():
        carried()
        c.showPage()
        page[0] += 1
        page_frame()
        state["y"] = body_top
        state["letter"] = 0
        if page_totals:
            return
        c.setFont(FI, FS)
        c.drawString(X["desc"][0] + 4, state["y"], "Brought forward")
        amt = round(state["sum"], 2) if priced else None
        if priced:
            rjust(fmt(amt), "amount", state["y"])
        truth_rows.append([None, "Brought forward", None, None, None, amt])
        roles.append("bf")
        lines_info.append(1)
        state["y"] -= LH * 2

    page_frame()
    dw = X["desc"][1] - X["desc"][0] - 8
    for r in recs:
        if r["role"] == "item":
            r["_lines"] = simpleSplit(r["desc"], font, FS, dw)
    for idx, r in enumerate(recs):
        if r["role"] in ("section", "subsection"):
            nxt = next((x for x in recs[idx + 1:] if x["role"] == "item"), None)
            need = LH * 2 + (LH * (len(nxt["_lines"]) + 1) if nxt else 0)
        else:
            need = LH * (len(r["_lines"]) + 1)
        if state["y"] - need < cf_y + LH * 1.5:
            new_page()
        y = state["y"]
        if r["role"] in ("section", "subsection"):
            c.setFont(FB, FS)
            c.drawString(X["desc"][0] + 4, y, r["desc"])
            if r["role"] == "section":
                wtxt = c.stringWidth(r["desc"], FB, FS)
                c.line(X["desc"][0] + 4, y - 1.5, X["desc"][0] + 4 + wtxt, y - 1.5)
            truth_rows.append([None, r["desc"], None, None, None, None])
            roles.append(r["role"])
            lines_info.append(1)
            state["y"] -= LH * (2 if r["role"] == "section" else 1.5)
            continue
        if ref_style == "letters":
            ref = letter_ref(state["letter"])
        else:
            ref = "%d.%02d" % (bill_no, state["n"] + 1)
        state["letter"] += 1
        state["n"] += 1
        c.setFont(font, FS)
        c.drawCentredString(sum(X["ref"]) / 2, y, ref)
        for k, ln in enumerate(r["_lines"]):
            c.drawString(X["desc"][0] + 4, y - k * LH, ln)
        qy = y - (len(r["_lines"]) - 1) * LH if qty_on == "last" else y
        if r["qty"] is not None:
            rjust(fmt(r["qty"]) if r["unit"] not in ("nr", "No", "kg") else "{:,}".format(int(r["qty"])), "qty", qy)
        c.drawCentredString(sum(X["unit"]) / 2, qy, r["unit"])
        if priced:
            if r["rate"] is not None:
                rjust(fmt(r["rate"]), "rate", qy)
            if r["amount"] is not None:
                rjust(fmt(r["amount"]), "amount", qy)
                state["sum"] += r["amount"]
                state["page_sum"] += r["amount"]
        elif leaders:
            c.setFont(font, 7)
            c.drawString(X["rate"][0] + 4, qy, "." * 18)
            c.drawString(X["amount"][0] + 4, qy, "." * 24)
        truth_rows.append([ref, " ".join(r["_lines"]), r["qty"], r["unit"], r["rate"] if priced else None,
                           r["amount"] if priced else None])
        roles.append("item")
        lines_info.append(len(r["_lines"]))
        state["y"] -= need
    # final total
    y = max(state["y"] - LH, cf_y)
    c.setFont(FB, FS)
    label = "Total carried to Collection" if page_totals else "Total Carried to Collection"
    c.drawString(X["desc"][0] + 4, y, label)
    amt = round(state["page_sum"] if page_totals else state["sum"], 2) if priced else None
    if priced:
        rjust(fmt(amt), "amount", y, FB)
        c.line(X["amount"][0] + 4, y + LH - 1, X["amount"][1] - 4, y + LH - 1)
        c.line(X["amount"][0] + 4, y - 3, X["amount"][1] - 4, y - 3)
    truth_rows.append([None, label, None, None, None, amt])
    roles.append("total")
    lines_info.append(1)
    c.showPage()
    c.save()
    types = [[("e" if v in (None, "") else ("n" if isinstance(v, (int, float)) else "s")) for v in row]
             for row in truth_rows]
    return {"case": name, "kind": "xlsx", "group": "qs", "source": "reportlab", "scanned": False,
            "description": "QS-software style printout (reportlab, %s): %s, qty/unit on %s line of multi-line "
                           "descriptions, %s, %s" % (
                               font, "vertical column lines only" if vlines else "no column lines at all", qty_on,
                               "page totals to collection" if page_totals else "carried/brought forward",
                               "priced" if priced else "unpriced with dotted leaders" if leaders else "unpriced"),
            "page_furniture": [T.PROJECT_SHORT.upper(), "BILL No. %d - %s" % (bill_no, bill_title),
                               T.TENDER_REF, "Page %d/#" % bill_no],
            "sheets": [{"name": "Bill %d" % bill_no, "columns": ["ref", "desc", "qty", "unit", "rate", "amount"],
                        "rows": truth_rows, "types": types, "roles": roles, "lines": lines_info,
                        "header_rows": [0], "repeat_rows": [0], "optional_roles": ["cf", "bf"]}],
            "_src": None}


def build_qs_lastline():
    return build_qs("qs_lastline", qty_on="last", priced=True, bill_no=4, bill_title="FINISHES",
                    secs=["PLASTERING AND PAINTING", "FLOOR AND WALL TILING", "CEILINGS", "MASONRY",
                          "WATERPROOFING", "CONCRETE WORK", "REINFORCEMENT AND FORMWORK"])


def build_qs_nolines():
    return build_qs("qs_nolines", qty_on="last", priced=True, bill_no=5, bill_title="DOORS, CEILINGS AND TILING",
                    secs=["DOORS AND IRONMONGERY", "CEILINGS", "FLOOR AND WALL TILING", "MASONRY"],
                    vlines=False, page_totals=True, font="Courier", ref_style="dotted")


def build_qs_firstline():
    return build_qs("qs_firstline", qty_on="first", priced=False, leaders=True, bill_no=6,
                    bill_title="EXTERNAL WORKS AND DOORS",
                    secs=["PRELIMINARIES", "EXTERNAL WORKS", "DOORS AND IRONMONGERY", "EXCAVATION AND EARTHWORK",
                          "CEILINGS"])


# ======================================================================
#  DOCX documents
# ======================================================================

def _docx():
    from docx import Document
    from docx.shared import Pt
    from docx.shared import Mm
    d = Document()
    d.sections[0].page_width = Mm(210)   # A4, not python-docx's default US Letter
    d.sections[0].page_height = Mm(297)
    d.sections[0].left_margin = d.sections[0].right_margin = Mm(25)
    st = d.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(11)
    return d


def add_marked(par, text, base_bold=None, base_italic=None, size=None):
    """Add runs parsed from {b:..} {i:..} {u:..} {bi:..} {s:..} markup."""
    from docx.shared import Pt
    pos = 0
    for m in re.finditer(r"\{(b|i|u|bi|bu|s):([^}]*)\}", text):
        if m.start() > pos:
            r = par.add_run(text[pos:m.start()])
            r.bold, r.italic = base_bold, base_italic
            if size:
                r.font.size = Pt(size)
        r = par.add_run(m.group(2))
        tag = m.group(1)
        r.bold = True if "b" in tag else base_bold
        r.italic = True if "i" in tag else base_italic
        if tag in ("u", "bu"):
            r.underline = True
        if tag == "s":
            r.font.superscript = True
        if size:
            r.font.size = Pt(size)
        pos = m.end()
    if pos < len(text):
        r = par.add_run(text[pos:])
        r.bold, r.italic = base_bold, base_italic
        if size:
            r.font.size = Pt(size)
    return par


def add_field(par, instr, cached="1"):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    for kind, payload in (("begin", None), ("instr", instr), ("separate", None), ("text", cached),
                          ("end", None)):
        r = par.add_run()
        if kind == "instr":
            it = OxmlElement("w:instrText")
            it.set(qn("xml:space"), "preserve")
            it.text = " %s " % payload
            r._r.append(it)
        elif kind == "text":
            r.text = payload
        else:
            f = OxmlElement("w:fldChar")
            f.set(qn("w:fldCharType"), kind)
            r._r.append(f)


def set_header_footer(doc, header_text=None, footer_page=True, footer_prefix="Page ", section=None):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt
    sec = section or doc.sections[0]
    if header_text:
        hp = sec.header.paragraphs[0]
        r = hp.add_run(header_text)
        r.font.size = Pt(8)
        hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    if footer_page:
        fp = sec.footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fp.add_run(footer_prefix)
        add_field(fp, "PAGE")
        fp.add_run(" of ")
        add_field(fp, "NUMPAGES")
        for r in fp.runs:
            r.font.size = Pt(8)


def shade(cell, hexcolor):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    tcPr = cell._tc.get_or_add_tcPr()
    s = OxmlElement("w:shd")
    s.set(qn("w:val"), "clear")
    s.set(qn("w:color"), "auto")
    s.set(qn("w:fill"), hexcolor)
    tcPr.append(s)


def add_table(doc, rows, header_fill="D9D9D9", widths=None, font_size=9, markup=False):
    from docx.shared import Cm, Pt
    t = doc.add_table(rows=len(rows), cols=len(rows[0]))
    t.style = "Table Grid"
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            cell = t.cell(i, j)
            p = cell.paragraphs[0]
            if markup:
                add_marked(p, str(v), base_bold=True if i == 0 else None, size=font_size)
            else:
                r = p.add_run(str(v))
                r.font.size = Pt(font_size)
                if i == 0:
                    r.bold = True
            if i == 0 and header_fill:
                shade(cell, header_fill)
            if widths:
                cell.width = Cm(widths[j])
    if widths:
        t.autofit = False
        for j, w in enumerate(widths):
            t.columns[j].width = Cm(w)
    return t


def make_figure(path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6.4, 3.4), dpi=120)
    for i in range(9):
        for j in range(4):
            ax.add_patch(plt.Rectangle((i * 0.62, j * 0.62), 0.6, 0.6, fill=True, fc="#e8e4dc", ec="#555",
                                       lw=0.6))
    ax.plot([3.1, 3.1], [-0.2, 2.7], color="#c0392b", lw=2.2)
    ax.annotate("Movement joint\n(max. 6 m centres)", xy=(3.1, 2.0), xytext=(4.1, 2.85), fontsize=8,
                arrowprops=dict(arrowstyle="->", lw=0.8))
    ax.annotate("600x600 porcelain tile\n3 mm joint", xy=(0.9, 0.9), xytext=(-0.2, 2.95), fontsize=8,
                arrowprops=dict(arrowstyle="->", lw=0.8))
    ax.set_xlim(-0.4, 6.0)
    ax.set_ylim(-0.4, 3.4)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def make_logo(path):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (720, 200), "white")
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 10, 210, 190), radius=24, fill="#1f4e79")
    fb = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 72)
    fs = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
    d.text((110, 100), "ABC", font=fb, fill="white", anchor="mm")
    d.text((235, 60), "GULF COAST", font=fs, fill="#1f4e79")
    d.text((235, 110), "CONTRACTING LLC", font=fs, fill="#1f4e79")
    img.save(path)


def hanging(par, cm=1.5, justify=False):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm
    pf = par.paragraph_format
    pf.left_indent = Cm(cm)
    pf.first_line_indent = Cm(-cm)
    pf.tab_stops.add_tab_stop(Cm(cm))
    if justify:
        par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY


def docx_case(name, descr, build, extra_files=()):
    path = os.path.join(CORPUS, name + ".docx")
    doc = build()
    doc.save(path)
    return {"case": name, "kind": "docx", "group": "doc", "source": "docx", "scanned": False,
            "description": descr, "_src": path}


def build_doc_spec():
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Pt

    def b():
        doc = _docx()
        rng = rng_for("doc_spec")
        set_header_footer(doc, T.PROJECT_SHORT + "  |  Specification Section 09 30 13 - Tiling")
        doc.add_heading("SECTION 09 30 13 - CERAMIC AND PORCELAIN TILING", level=0)
        p = doc.add_paragraph()
        add_marked(p, "Issued for Tender - Revision 0 - {i:October 2026}")
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fill_i = 0
        clause_count = {}
        for item in T.SPEC:
            kind = item[0]
            if kind == "h1":
                doc.add_heading(item[1], level=1)
            elif kind == "h2":
                doc.add_heading(item[1], level=2)
            elif kind == "h3":
                doc.add_heading(item[1], level=3)
            elif kind == "cl":
                p = doc.add_paragraph()
                add_marked(p, item[1] + "\t" + item[2])
                hanging(p, 1.5, justify=True)
                pre = item[1].rsplit(".", 1)[0]
                clause_count[pre] = int(item[1].rsplit(".", 1)[1])
            elif kind == "bul":
                p = doc.add_paragraph(style="List Bullet")
                add_marked(p, item[1])
                p.paragraph_format.left_indent = Cm(2.2)
            elif kind == "table":
                cap = doc.add_paragraph()
                add_marked(cap, "{bi:Table 1} - Tile schedule")
                cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                add_table(doc, T.TILE_TABLE, widths=[1.6, 5.6, 2.4, 2.2, 2.0])
                doc.add_paragraph()
            elif kind == "figure":
                fig = os.path.join(CORPUS, "_spec_figure.png")
                make_figure(fig)
                doc.add_picture(fig, width=Cm(12))
                doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
                os.remove(fig)
                cap = doc.add_paragraph()
                add_marked(cap, "{i:Figure 1 - Typical floor tile setting-out and movement joint detail}")
                cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            # general filler clauses after selected h2 sections, to reach ~8 pages
            if kind == "cl" and item[1] in ("1.1.3", "1.3.5", "1.4.3", "2.2.3", "3.3.4", "3.4.2", "1.6.1",
                                            "2.3.3", "3.2.2", "3.5.2", "1.2.2", "3.1.2"):
                pre = item[1].rsplit(".", 1)[0]
                for _ in range(3):
                    clause_count[pre] += 1
                    num = "%s.%d" % (pre, clause_count[pre])
                    p = doc.add_paragraph()
                    add_marked(p, num + "\t" + T.SPEC_FILLER[fill_i % len(T.SPEC_FILLER)])
                    hanging(p, 1.5, justify=True)
                    fill_i += 1
        p = doc.add_paragraph()
        add_marked(p, "{b:END OF SECTION}")
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        return doc
    return docx_case("doc_spec", "7-page specification: Title/H1-H3, literal 1.1.1 clauses with hanging indent, "
                     "bullets, b/i/u runs, m2/m3 superscripts, table, figure, header and Page X of Y footer", b)


def build_doc_letter():
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Pt, RGBColor

    def b():
        doc = _docx()
        sec = doc.sections[0]
        sec.top_margin = Cm(1.5)
        logo = os.path.join(CORPUS, "_logo.png")
        make_logo(logo)
        doc.add_picture(logo, width=Cm(6))
        os.remove(logo)
        p = doc.add_paragraph()
        r = p.add_run("P.O. Box 12345, Al Quoz Industrial Area 3, Dubai, United Arab Emirates  |  Tel +971 4 000 0000")
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
        p = doc.add_paragraph("27 October 2026")
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        add_marked(doc.add_paragraph(), "Our Ref: {b:ABC/T0011/LTR/0147}")
        for line in ["The Project Director", T.CLIENT, "P.O. Box 54321", "Dubai, United Arab Emirates"]:
            p = doc.add_paragraph(line)
            p.paragraph_format.space_after = Pt(0)
        doc.add_paragraph()
        add_marked(doc.add_paragraph(), "{b:Attention: Mr. Sameer Joshi, Development Director}")
        p = doc.add_paragraph()
        add_marked(p, "{bu:Subject: Residential Tower on Plot JVC-0512 - Submission of Post-Tender Clarifications}")
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        doc.add_paragraph("Dear Sir,")
        for t in T.LETTER_BODY:
            p = doc.add_paragraph(t)
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        doc.add_paragraph("Enclosures:")
        for e in T.LETTER_ENCLOSURES:
            doc.add_paragraph(e, style="List Number")
        doc.add_paragraph("Yours faithfully,")
        p = doc.add_paragraph("For and on behalf of")
        p.paragraph_format.space_after = Pt(0)
        add_marked(doc.add_paragraph(), "{b:%s}" % T.CONTRACTOR.upper())
        doc.add_paragraph()
        doc.add_paragraph()
        p = doc.add_paragraph()
        add_marked(p, "{b:Eng. Omar Haddad}")
        p.paragraph_format.space_after = Pt(0)
        doc.add_paragraph("Tendering Manager")
        p = doc.add_paragraph()
        r = p.add_run("cc: Project File; Commercial Department")
        r.font.size = Pt(8)
        r.italic = True
        fp = sec.footer.paragraphs[0]
        r = fp.add_run("Gulf Coast Contracting LLC - Commercial Licence No. 000000 - www.example.ae")
        r.font.size = Pt(7)
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        return doc
    return docx_case("doc_letter", "Letter: logo image, right-aligned date, centred bold-underlined subject, "
                     "justified body, numbered enclosures, signature block", b)


def _set_cols(section, n, space_twips=567):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    sp = section._sectPr
    cols = sp.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sp.append(cols)
    cols.set(qn("w:num"), str(n))
    cols.set(qn("w:space"), str(space_twips))


def build_doc_twocol():
    from docx.enum.section import WD_SECTION
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    def b():
        doc = _docx()
        set_header_footer(doc, None, footer_prefix="Addendum No. 2 - Page ")
        doc.add_heading("TENDER ADDENDUM No. 2 - GENERAL NOTES", level=1)
        add_marked(doc.add_paragraph(), "{b:Project:} " + T.PROJECT)
        add_marked(doc.add_paragraph(), "{b:Date:} 26 October 2026        {b:Issued by:} " + T.CONSULTANT)
        sec = doc.add_section(WD_SECTION.CONTINUOUS)
        _set_cols(sec, 2)
        for kind, text in T.TWO_COL:
            if kind == "h2":
                doc.add_heading(text, level=2)
            else:
                p = doc.add_paragraph(text)
                p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        return doc
    return docx_case("doc_twocol", "Single-column title block then a continuous two-column section (reading "
                     "order: left column then right)", b)


def _rtl(p, font="DejaVu Sans"):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    pPr = p._p.get_or_add_pPr()
    bidi = OxmlElement("w:bidi")
    pPr.insert(0, bidi)
    for r in p.runs:
        rPr = r._r.get_or_add_rPr()
        f = OxmlElement("w:rFonts")
        f.set(qn("w:cs"), font)
        rPr.insert(0, f)
        rPr.append(OxmlElement("w:rtl"))


def build_doc_arabic():
    def b():
        doc = _docx()
        set_header_footer(doc, T.PROJECT_SHORT + "  |  Instructions to Tenderers")
        doc.add_heading("INSTRUCTIONS TO TENDERERS - KEY TERMS", level=1)
        h = doc.add_heading("تعليمات إلى مقدمي العطاءات", level=2)
        _rtl(h)
        for en, ar in T.ARABIC_PAIRS:
            doc.add_paragraph(en)
            _rtl(doc.add_paragraph(ar))
        doc.add_paragraph("Tender reference and bid bond (mixed Arabic / Latin text):")
        _rtl(doc.add_paragraph(T.ARABIC_MIXED))
        return doc
    return docx_case("doc_arabic", "English paragraphs alternating with right-to-left Arabic paragraphs, "
                     "Arabic heading, mixed Arabic/Latin line", b)


def build_doc_superscript():
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    def b():
        doc = _docx()
        doc.add_heading("SCHEDULE OF AREAS AND KEY QUANTITIES", level=1)
        paras = [
            "The gross floor area (GFA) of the tower is 24,850 m{s:2}, of which 19,420 m{s:2} is saleable "
            "residential area and 1,960 m{s:2} is retail at ground floor.",
            "The total volume of structural concrete is estimated at 11,280 m{s:3}, with an average "
            "reinforcement ratio of 165 kg/m{s:3} and post-tensioned slabs on typical floors.",
            "Design loads: superimposed dead load 1.5 kN/m{s:2}, live load 2.0 kN/m{s:2} in apartments and "
            "4.0 kN/m{s:2} in corridors and lobbies; basic wind pressure 1.2 kN/m{s:2}.",
            "Concrete cube strength shall be 50 N/mm{s:2} for columns and core walls and 45 N/mm{s:2} for "
            "slabs; blinding shall be 15 N/mm{s:2}.",
            "The 1{s:st} to 12{s:th} floors are typical. Water storage: 2 x 150 m{s:3} at roof level and "
            "1 x 300 m{s:3} at basement B2.",
        ]
        for t in paras:
            p = doc.add_paragraph()
            add_marked(p, t)
        cap = doc.add_paragraph()
        add_marked(cap, "{b:Table 1} - Areas and quantities by level")
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        rows = [["Level", "Use", "GFA (m{s:2})", "Concrete (m{s:3})", "Rebar (kg/m{s:3})"],
                ["B2", "Parking, tanks", "3,420", "2,960", "140"],
                ["B1", "Parking", "3,420", "1,850", "135"],
                ["GF", "Lobby, retail", "2,640", "980", "160"],
                ["1-12", "Residential", "14,160", "4,890", "170"],
                ["Roof", "Plant", "1,210", "600", "150"]]
        add_table(doc, rows, markup=True, widths=[1.8, 4.0, 3.0, 3.4, 3.4])
        return doc
    return docx_case("doc_superscript", "Superscript runs (m2, m3, N/mm2, 1st) in body text and table headers",
                     b)


def build_doc_justified():
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm

    def b():
        doc = _docx()
        set_header_footer(doc, "Particular Conditions of Contract - Part B")
        doc.add_heading("PARTICULAR CONDITIONS OF CONTRACT - PART B", level=1)
        p = doc.add_paragraph()
        add_marked(p, "{i:The following Particular Conditions amend and supplement the General Conditions. "
                      "Clause numbers refer to the corresponding Sub-Clauses of the General Conditions.}")
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        for item in T.CONDITIONS:
            if item[0] == "h2":
                doc.add_heading(item[1], level=2)
            elif item[0] == "p":
                p = doc.add_paragraph(item[1])
                p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            else:
                p = doc.add_paragraph(item[1] + "\t" + item[2])
                hanging(p, 1.0, justify=True)
                p.paragraph_format.left_indent = Cm(2.0)
        return doc
    return docx_case("doc_justified", "Justified contract-conditions page with Heading 2 sub-clauses and "
                     "(a)/(b)/(c) hanging-indent items", b)


def build_doc_minutes():
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    def b():
        doc = _docx()
        set_header_footer(doc, "MoM-04  |  " + T.PROJECT_SHORT)
        doc.add_heading("MINUTES OF MEETING No. 04", level=1)
        info = [["Project", T.PROJECT], ["Meeting", "Post-tender clarification meeting"],
                ["Date / Time", "21 October 2026, 10:00 - 12:15"], ["Venue", T.CONSULTANT + " office, Business Bay"]]
        add_table(doc, info, header_fill=None, widths=[3.5, 12.5], font_size=10)
        doc.add_heading("1. Attendees", level=2)
        add_table(doc, T.MINUTES_ATTENDEES, header_fill="DDEBF7", widths=[5, 6.5, 4.5])
        doc.add_heading("2. Discussion", level=2)
        for num, text in T.MINUTES_ITEMS:
            p = doc.add_paragraph(num + "\t" + text)
            hanging(p, 1.2, justify=True)
        doc.add_heading("3. Action Items", level=2)
        rows = list(T.MINUTES_ACTIONS)
        t = add_table(doc, rows[:1] + [["Technical", "", "", ""]] + rows[1:3] + [["Commercial", "", "", ""]] +
                      rows[3:], header_fill="DDEBF7", widths=[1.2, 9.3, 2.8, 2.7])
        for ri in (1, 4):
            a = t.cell(ri, 0).merge(t.cell(ri, 3))
            for extra in a.paragraphs[1:]:
                if not extra.text.strip():
                    extra._p.getparent().remove(extra._p)
            for r in a.paragraphs[0].runs:
                r.bold = True
            shade(a, "F2F2F2")
        p = doc.add_paragraph()
        add_marked(p, "{i:The next meeting will be held on 4 November 2026 at the same venue. Any comments on "
                      "these minutes shall be submitted within seven (7) days, failing which they will be deemed "
                      "accepted.}")
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        return doc
    return docx_case("doc_minutes", "Minutes of meeting: key/value table, shaded-header tables, merged group "
                     "rows, literal 4.1 items", b)


# ======================================================================
#  Scanning
# ======================================================================

def _stamp(color, lines, scale):
    from PIL import Image, ImageDraw, ImageFont
    fb = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(34 * scale))
    fs = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(24 * scale))
    w, h = int(520 * scale), int(60 * scale + 40 * scale * len(lines))
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    lw = max(3, int(5 * scale))
    d.rectangle((lw, lw, w - lw, h - lw), outline=255, width=lw)
    d.rectangle((3 * lw, 3 * lw, w - 3 * lw, h - 3 * lw), outline=255, width=max(1, lw // 2))
    y = int(24 * scale)
    for k, t in enumerate(lines):
        f = fb if k == 0 else fs
        d.text((w // 2, y + int(16 * scale)), t, font=f, fill=255, anchor="mm")
        y += int(40 * scale)
    return img


def scan_pdf(src, dst, *, dpi, seed, angle, stamps):
    """Rasterise src at dpi, stamp, rotate, add noise; write an image-only PDF (no text layer)."""
    import img2pdf
    from PIL import Image, ImageFilter
    rs = np.random.RandomState(seed)
    stamped = []
    tmp = tempfile.mkdtemp(prefix="scan_")
    try:
        import subprocess
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", src, os.path.join(tmp, "p")], check=True)
        files = sorted([f for f in os.listdir(tmp) if f.endswith(".png")],
                       key=lambda f: int(re.findall(r"\d+", f)[-1]))
        jpgs = []
        for pi, f in enumerate(files):
            img = Image.open(os.path.join(tmp, f)).convert("RGB")
            arr = np.asarray(img).astype(np.float32)
            scale = dpi / 200.0
            if pi in stamps:
                color, lines = stamps[pi]
                st = _stamp(color, lines, scale).rotate(rs.uniform(-12, 12), expand=True)
                a = np.asarray(st).astype(np.float32) / 255.0 * 0.85
                # ink texture
                a *= (0.75 + 0.25 * rs.rand(*a.shape))
                H, Wd = arr.shape[:2]
                y0 = int(rs.uniform(0.08, 0.6) * (H - a.shape[0]))
                x0 = int(rs.uniform(0.35, 0.95) * (Wd - a.shape[1]))
                col = np.array(color, dtype=np.float32)
                region = arr[y0:y0 + a.shape[0], x0:x0 + a.shape[1]]
                aa = a[:region.shape[0], :region.shape[1], None]
                arr[y0:y0 + a.shape[0], x0:x0 + a.shape[1]] = region * (1 - aa * (1 - col / 255.0))
                stamped.append(pi + 1)
            # paper tone
            arr = arr * 0.97 + 4
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            ang = angle * (1 if pi % 2 == 0 else 0.8) + rs.uniform(-0.1, 0.1)
            img = img.rotate(ang, resample=Image.BICUBIC, fillcolor=(246, 246, 244))
            img = img.filter(ImageFilter.GaussianBlur(0.55 * scale))
            arr = np.asarray(img).astype(np.float32)
            arr += rs.normal(0, 7.0, arr.shape[:2])[:, :, None]
            # sparse specks
            n = int(arr.shape[0] * arr.shape[1] * 0.00004)
            ys, xs = rs.randint(0, arr.shape[0], n), rs.randint(0, arr.shape[1], n)
            arr[ys, xs] = rs.uniform(40, 120, (n, 1))
            out = os.path.join(tmp, "s%03d.jpg" % pi)
            Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(out, quality=72, dpi=(dpi, dpi))
            jpgs.append(out)
        with open(dst, "wb") as fh:
            fh.write(img2pdf.convert(jpgs))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return stamped


SCANS = [
    # name, base, dpi, angle, stamps {page_index: (rgb, lines)}
    ("scan_boq_vlines", "boq_vlines", 200, 0.7,
     {0: ((30, 60, 200), ["RECEIVED", "ABC TENDERS DEPT.", "27 OCT 2026"])}),
    ("scan_qs_lastline", "qs_lastline", 200, -1.1,
     {1: ((200, 30, 40), ["COPY", "NOT FOR CONSTRUCTION"])}),
    ("scan_spec", "doc_spec", 200, 0.4,
     {0: ((30, 60, 200), ["APPROVED", "AL NOOR ENG. CONSULTANTS", "Code A - 25.10.2026"]),
      6: ((200, 30, 40), ["FOR TENDER", "PURPOSES ONLY"])}),
    ("scan_letter", "doc_letter", 300, -0.8,
     {0: ((200, 30, 40), ["RECEIVED", "EMIRATES HORIZON DEV.", "28 OCT 2026"])}),
]


# ======================================================================
#  main
# ======================================================================

BUILDERS = [build_boq_allborders, build_boq_vlines, build_boq_noborders, build_boq_landscape,
            build_boq_negative, build_boq_twolevel, build_boq_long, build_boq_twobills, build_boq_summary,
            build_tbl_doors, build_tbl_payments, build_tbl_comparison,
            build_qs_lastline, build_qs_firstline, build_qs_nolines,
            build_doc_spec, build_doc_letter, build_doc_twocol, build_doc_arabic, build_doc_superscript,
            build_doc_justified, build_doc_minutes]


def finalize_docx_truth(meta):
    d = docxread.read_docx(meta["_src"])
    meta.update({"paragraphs": d["paragraphs"], "tables": d["tables"], "images": d["images"],
                 "header": d["header"], "footer": d["footer"]})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="fnmatch pattern of case names to (re)build, e.g. 'boq_*'")
    ap.add_argument("--no-scan", action="store_true", help="skip the scanned variants")
    args = ap.parse_args()
    os.makedirs(CORPUS, exist_ok=True)
    t0 = time.time()

    def want(n):
        return not args.only or fnmatch.fnmatch(n, args.only)

    metas = []
    for bld in BUILDERS:
        name = bld.__name__[len("build_"):]
        scan_needs = [s for s in SCANS if s[1] == name and want(s[0]) and not args.no_scan]
        if not want(name) and not scan_needs:
            continue
        t = time.time()
        m = bld()
        metas.append(m)
        print("built %-18s %.1fs" % (name, time.time() - t), flush=True)
    to_convert = [m["_src"] for m in metas if m["_src"]]
    if to_convert:
        t = time.time()
        evalcore.soffice_convert(to_convert, CORPUS, "pdf")
        print("LibreOffice converted %d files in %.1fs" % (len(to_convert), time.time() - t), flush=True)
    by_name = {}
    for m in metas:
        pdf = os.path.join(CORPUS, m["case"] + ".pdf")
        if not os.path.exists(pdf):
            print("!! missing PDF for", m["case"])
            continue
        m["pdf_pages"] = evalcore.pdf_page_count(pdf)
        if m["kind"] == "docx":
            finalize_docx_truth(m)
            m["visual_ref"] = m["case"] + ".pdf"
        m["source_file"] = os.path.basename(m["_src"]) if m["_src"] else None
        by_name[m["case"]] = m
        if want(m["case"]):
            write_json(os.path.join(CORPUS, m["case"] + ".truth.json"), {k: v for k, v in m.items()
                                                                       if not k.startswith("_")})
            print("  %-18s %2d pages" % (m["case"], m["pdf_pages"]))
    if not args.no_scan:
        for sname, base, dpi, angle, stamps in SCANS:
            if not want(sname) or base not in by_name:
                continue
            t = time.time()
            dst = os.path.join(CORPUS, sname + ".pdf")
            stamped = scan_pdf(os.path.join(CORPUS, base + ".pdf"), dst, dpi=dpi,
                               seed=zlib.crc32(sname.encode()), angle=angle, stamps=stamps)
            tm = {k: v for k, v in by_name[base].items() if not k.startswith("_")}
            tm.update({"case": sname, "group": "scan", "scanned": True, "base": base, "dpi": dpi,
                       "rotation_deg": angle, "stamped_pages": stamped,
                       "description": "Image-only scan (%d dpi, %.1f deg, noise, stamp) of %s" % (
                           dpi, angle, base),
                       "pdf_pages": evalcore.pdf_page_count(dst), "source_file": None})
            if tm["kind"] == "docx":
                tm["visual_ref"] = base + ".pdf"
            write_json(os.path.join(CORPUS, sname + ".truth.json"), tm)
            print("scanned %-18s %.1fs" % (sname, time.time() - t), flush=True)
    print("done in %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()

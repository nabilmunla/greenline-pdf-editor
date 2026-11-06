#!/usr/bin/env python3
"""Score a converter's .xlsx output against a corpus truth file.

    python3 score_xlsx.py corpus/<case>.truth.json out.xlsx [--detail]

Truth rows of all sheets are concatenated (blank rows dropped) and aligned to the
predicted rows of all sheets (also concatenated, empty rows dropped) with a monotone
sequence alignment on normalised whole-row text, so extra / missing rows are tolerated
and counted.  Columns are then mapped per (truth sheet, predicted sheet) pair by maximum
total cell score (Hungarian assignment), so column offsets / extra columns do not matter.

Metrics (all 0..1 unless a count):
  score             headline: 0.45 cell_acc + 0.20 row_f1 + 0.15 numeric_as_number
                    + 0.10 desc_one_cell + 0.10 header_ok  (n/a parts re-weighted)
  cell_acc          mean cell score over every non-empty truth cell (missing rows score 0).
                    numbers: numeric cell with right value = 1, right value as text = 0.5;
                    text: 1 if equal after whitespace normalisation, else char similarity
  cell_acc_aligned  same, over matched rows only
  cell_exact        share of truth cells scoring 1.0
  columns           per-column cell_acc keyed by column role (ref, desc, qty, unit, rate, amount...)
  numeric_as_number share of numeric truth cells (with a non-empty mapped pred cell) stored as numbers
  numeric_value_ok  share of numeric truth cells whose value was recovered (number or text)
  rows_truth/pred, rows_matched, rows_missing, rows_extra, row_precision/recall/f1
  header_count / header_ideal / header_ok   occurrences of the column-header row (ideal: once per bill)
  desc_multiline, desc_one_cell   wrapped (>=2 line) descriptions recovered as ONE cell (sim >= 0.9)
  furniture_rows    unmatched pred rows that are page headers/footers ('Page 3 of 9', project name...)
  spurious_cells    non-empty pred cells where the truth cell (in a mapped column) is empty
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evalcore as E  # noqa: E402

PAGE_RE = re.compile(r"^\s*(page\s*)?\d+\s*(of|/)\s*\d+\s*$|^\s*page\s*\d+(\s*/\s*\d+)?\s*$", re.I)


def load_pred(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for r in ws.iter_rows(values_only=True):
            r = list(r)
            r = [None if (isinstance(v, str) and not v.strip()) else v for v in r]
            while r and r[-1] is None:
                r.pop()
            if r:
                rows.append(r)
        sheets.append((ws.title, rows))
    # formulas without cached values read back as empty: count them so it is visible
    nform = 0
    try:
        wb2 = openpyxl.load_workbook(path, data_only=False)
        for ws, (_, _rows) in zip(wb2.worksheets, sheets):
            for row in ws.iter_rows():
                for c in row:
                    if c.data_type == "f":
                        nform += 1
    except Exception:
        pass
    return sheets, nform


def _furniture_norm(s):
    s = E.norm_text(s).lower().replace("#", "")
    return E.norm_ws(re.sub(r"\d+", "", s))


def score_xlsx(truth, out_path):
    sheets, nformulas = load_pred(out_path)
    T_rows, T_types, T_opt, T_grp, T_role, T_lines, T_desc = [], [], [], [], [], [], []
    header_keys = []
    for si, sh in enumerate(truth["sheets"]):
        opt_roles = set(sh.get("optional_roles", []))
        cols = sh["columns"]
        dcol = cols.index("desc") if "desc" in cols else None
        best_h, best_n = None, -1
        for hi in sh.get("header_rows", []):
            n = sum(1 for v in sh["rows"][hi] if v not in (None, ""))
            if n > best_n:
                best_h, best_n = hi, n
        if best_h is not None:
            header_keys.append(E.row_key(sh["rows"][best_h]))
        for ri, row in enumerate(sh["rows"]):
            role = sh["roles"][ri]
            if role == "blank" or all(v in (None, "") for v in row):
                continue
            T_rows.append(row)
            T_types.append(sh["types"][ri])
            T_opt.append(role in opt_roles)
            T_grp.append(si)
            T_role.append(role)
            T_lines.append(sh["lines"][ri] if "lines" in sh else 1)
            T_desc.append(row[dcol] if dcol is not None else None)
    P_rows, P_grp = [], []
    for pi, (_, rows) in enumerate(sheets):
        for r in rows:
            P_rows.append(r)
            P_grp.append(pi)

    res = E.compare_grids(T_rows, P_rows, T_types, T_opt, truth_group=T_grp, pred_group=P_grp)
    matched = res["matched"]
    n_req = sum(1 for o in T_opt if not o)
    m_req = sum(1 for i in matched if not T_opt[i])
    m_opt = len(matched) - m_req
    n_pred = len(P_rows)
    prec = m_req / max(1, n_pred - m_opt)
    rec = m_req / max(1, n_req)

    cells = [c for c in res["cells"] if not T_opt[c[0]]]
    cell_acc = sum(c[2] for c in cells) / len(cells) if cells else 1.0
    cells_al = [c for c in cells if c[0] in matched]
    cell_acc_al = sum(c[2] for c in cells_al) / len(cells_al) if cells_al else 0.0
    exact = sum(1 for c in cells if c[2] >= 0.999) / len(cells) if cells else 1.0

    # per column (by role name of the truth sheet column)
    percol = {}
    for (ti, tc, sc, _, _) in cells:
        name = truth["sheets"][T_grp[ti]]["columns"][tc] if tc < len(truth["sheets"][T_grp[ti]]["columns"]) \
            else "c%d" % tc
        a = percol.setdefault(name, [0.0, 0])
        a[0] += sc
        a[1] += 1
    columns = {k: E.rnd(v[0] / v[1]) for k, v in percol.items()}

    num = [c for c in cells if T_types[c[0]][c[1]] in ("n", "p")]
    num_nonempty = [c for c in num if c[3] is not None]
    numeric_as_number = (sum(1 for c in num_nonempty if c[3]) / len(num_nonempty)) if num_nonempty else (
        0.0 if num else None)
    numeric_value_ok = (sum(1 for c in num if c[2] >= 0.5) / len(num)) if num else None

    # header occurrences
    pkeys = res["pkeys"]
    hcount = 0
    if header_keys:
        for k in pkeys:
            if k and max(E.sim(k, h) for h in header_keys) >= 0.75:
                hcount += 1
    hideal = len(header_keys)
    if hideal == 0:
        header_ok = None
    elif hcount == 0:
        header_ok = 0.0
    else:
        header_ok = min(hcount, hideal) / max(hcount, hideal)

    # wrapped descriptions as one cell
    ml = [i for i in range(len(T_rows)) if T_role[i] == "item" and T_lines[i] >= 2 and T_desc[i]]
    ok = 0
    for i in ml:
        j = matched.get(i)
        if j is None:
            continue
        td = E.norm_text(T_desc[i])
        if any(E.sim(td, E.cell_str(v)) >= 0.9 for v in P_rows[j] if v is not None):
            ok += 1
    desc_one = ok / len(ml) if ml else None

    # page furniture leaked into rows
    furn = [_furniture_norm(f) for f in truth.get("page_furniture", []) if _furniture_norm(f)]
    pmatched = set(matched.values())
    furn_rows = 0
    extra_examples = []
    for j, r in enumerate(P_rows):
        if j in pmatched:
            continue
        txt = " ".join(E.cell_str(v) for v in r if v is not None)
        fn = _furniture_norm(txt)
        is_f = bool(PAGE_RE.match(E.norm_text(txt))) or any(E.sim(fn, f) >= 0.85 for f in furn) or (
            fn and any(f and f in fn and len(f) > 12 for f in furn) and len(fn) < 2 * max(len(f) for f in furn))
        if is_f:
            furn_rows += 1
        elif len(extra_examples) < 12:
            extra_examples.append(txt[:110])

    parts = [(0.45, cell_acc), (0.20, E.f1(prec, rec)), (0.15, numeric_as_number), (0.10, desc_one),
             (0.10, header_ok)]
    tw = sum(w for w, v in parts if v is not None)
    score = sum(w * v for w, v in parts if v is not None) / tw

    missing_examples = [(T_desc[i] or E.row_key(T_rows[i]))[:110] for i in range(len(T_rows))
                        if i not in matched and not T_opt[i]][:12]
    worst = sorted([c for c in cells_al if c[2] < 0.999], key=lambda c: c[2])[:12]
    worst_cells = []
    for (ti, tc, sc, _, _) in worst:
        j = matched[ti]
        cm = res["colmap"].get((T_grp[ti], P_grp[j]), {})
        pv = P_rows[j][cm[tc]] if tc in cm and cm[tc] < len(P_rows[j]) else None
        worst_cells.append({"truth": T_rows[ti][tc], "pred": E.cell_str(pv)[:80] if pv is not None else None,
                            "score": round(sc, 3)})
    return {
        "score": E.rnd(score),
        "cell_acc": E.rnd(cell_acc),
        "cell_acc_aligned": E.rnd(cell_acc_al),
        "cell_exact": E.rnd(exact),
        "columns": columns,
        "numeric_as_number": E.rnd(numeric_as_number),
        "numeric_value_ok": E.rnd(numeric_value_ok),
        "rows_truth": n_req,
        "rows_pred": n_pred,
        "rows_matched": m_req,
        "rows_missing": n_req - m_req,
        "rows_extra": max(0, n_pred - m_req - m_opt),
        "row_precision": E.rnd(prec),
        "row_recall": E.rnd(rec),
        "row_f1": E.rnd(E.f1(prec, rec)),
        "header_count": hcount,
        "header_ideal": hideal,
        "header_ok": E.rnd(header_ok),
        "desc_multiline": len(ml),
        "desc_one_cell": E.rnd(desc_one),
        "furniture_rows": furn_rows,
        "spurious_cells": res["spurious"],
        "sheets_pred": len(sheets),
        "formula_cells": nformulas,
        "detail": {"missing_rows": missing_examples, "extra_rows": extra_examples, "worst_cells": worst_cells},
    }


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("truth")
    ap.add_argument("out")
    ap.add_argument("--detail", action="store_true", help="include examples of missing/extra rows and bad cells")
    a = ap.parse_args()
    with open(a.truth, encoding="utf-8") as f:
        truth = json.load(f)
    m = score_xlsx(truth, a.out)
    if not a.detail:
        m.pop("detail", None)
    print(json.dumps(m, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()

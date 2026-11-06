"""Shared helpers for the PDF -> XLSX / DOCX evaluation harness.

Text normalisation, number/date parsing, row alignment, grid (table) comparison,
LibreOffice conversion, PDF rendering and SSIM.  Used by make_corpus.py,
score_xlsx.py, score_docx.py and run.py.
"""
import datetime as _dt
import difflib
import math
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata

import numpy as np

try:
    from rapidfuzz import fuzz as _fuzz
    from rapidfuzz import process as _process
    from rapidfuzz.distance import Indel as _Indel
    HAVE_RAPIDFUZZ = True
except Exception:  # pragma: no cover - fallback path
    HAVE_RAPIDFUZZ = False

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")

# ---------------------------------------------------------------- text ----

_SUPERSCRIPTS = {"²": "2", "³": "3", "¹": "1", "⁰": "0", "⁴": "4",
                 "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9"}
_PUNCT_MAP = {"‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
              "–": "-", "—": "-", "−": "-", " ": " ", " ": " ",
              " ": " ", "­": "", "​": "", "‎": "", "‏": "",
              "‪": "", "‫": "", "‬": "", "‭": "", "‮": "",
              "⁦": "", "⁧": "", "⁨": "", "⁩": "", "﻿": ""}
_PUNCT_RE = re.compile("|".join(map(re.escape, _PUNCT_MAP)))


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def norm_text(s):
    """Unicode/whitespace normalisation used for every text comparison.

    NFKC (folds ligatures, Arabic presentation forms, superscript digits -> digits),
    curly quotes/dashes -> ASCII, bidi control characters removed, whitespace collapsed.
    Case is preserved.
    """
    if s is None:
        return ""
    s = str(s)
    s = _PUNCT_RE.sub(lambda m: _PUNCT_MAP[m.group(0)], s)
    s = unicodedata.normalize("NFKC", s)
    return norm_ws(s)


def sim(a, b):
    """Character-level similarity in [0,1] (Indel ratio, like difflib's ratio)."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    if HAVE_RAPIDFUZZ:
        return _fuzz.ratio(a, b) / 100.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def seq_ratio(a, b):
    """Similarity of two sequences of hashables (e.g. word lists), in [0,1]."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if HAVE_RAPIDFUZZ:
        return 1.0 - _Indel.normalized_distance(a, b)
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def seq_matches(a, b):
    """Return list of (i, j) index pairs of an LCS alignment between sequences a and b."""
    pairs = []
    if not a or not b:
        return pairs
    if HAVE_RAPIDFUZZ:
        for tag, i1, i2, j1, j2 in _Indel.opcodes(a, b):
            if tag == "equal":
                pairs.extend(zip(range(i1, i2), range(j1, j2)))
    else:
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        for blk in sm.get_matching_blocks():
            pairs.extend(zip(range(blk.a, blk.a + blk.size), range(blk.b, blk.b + blk.size)))
    return pairs


def sim_matrix(rows_a, rows_b):
    """Pairwise similarity matrix (len(a) x len(b)) of strings."""
    if not rows_a or not rows_b:
        return np.zeros((len(rows_a), len(rows_b)), dtype=np.float32)
    if HAVE_RAPIDFUZZ:
        m = _process.cdist(rows_a, rows_b, scorer=_fuzz.ratio, workers=-1, dtype=np.float32)
        return np.asarray(m, dtype=np.float32) / 100.0
    out = np.zeros((len(rows_a), len(rows_b)), dtype=np.float32)
    for i, a in enumerate(rows_a):
        for j, b in enumerate(rows_b):
            out[i, j] = sim(a, b)
    return out


# ------------------------------------------------------ numbers / dates ----

_NUM_BODY = re.compile(r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+")
_CURRENCY = re.compile(r"^(?:AED|DHS?\.?|USD|US\$|\$|EUR|€|£)\s*|\s*(?:AED|DHS?\.?|USD)$", re.I)


def parse_number(s):
    """Parse displayed numeric text: '1,250.50', '(1,234.00)', '-12', 'AED 5,000.00', '5.0%'.

    Returns float (percentages divided by 100) or None.
    """
    if s is None:
        return None
    t = norm_text(s).replace(" ", "")
    if not t:
        return None
    neg = False
    if t.startswith("(") and t.endswith(")"):
        neg, t = True, t[1:-1]
    t = _CURRENCY.sub("", t)
    if t.startswith("(") and t.endswith(")"):
        neg, t = not neg, t[1:-1]
    pct = t.endswith("%")
    if pct:
        t = t[:-1]
    if t.startswith("-") or t.startswith("+"):
        neg = neg != (t[0] == "-")
        t = t[1:]
    elif t.endswith("-"):
        neg, t = not neg, t[:-1]
    if not _NUM_BODY.fullmatch(t):
        return None
    v = float(t.replace(",", ""))
    if pct:
        v /= 100.0
    return -v if neg else v


_DATE_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y", "%d-%b-%Y",
                 "%d-%b-%y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d", "%d-%B-%Y", "%b %d, %Y",
                 "%B %d, %Y", "%d %b %y", "%Y/%m/%d")


def parse_date(s):
    if s is None:
        return None
    if isinstance(s, _dt.datetime):
        return s.date()
    if isinstance(s, _dt.date):
        return s
    t = norm_text(s)
    t = re.sub(r"\s+00:00(:00)?$", "", t)
    for f in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(t, f).date()
        except ValueError:
            pass
    return None


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not (
        isinstance(v, float) and math.isnan(v))


def fmt_num(v):
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return ("%.6f" % v).rstrip("0").rstrip(".")


def close(a, b):
    return abs(a - b) <= 0.005 + 1e-9 * abs(b)


def cell_str(v):
    """Canonical display string of a predicted cell value (for text comparison)."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if is_number(v):
        return fmt_num(v)
    if isinstance(v, _dt.datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    return norm_text(v)


def key_str(v):
    """Loose canonical form used to build row keys for alignment."""
    s = cell_str(v)
    if not s:
        return ""
    if not is_number(v):
        n = parse_number(s)
        if n is not None:
            return fmt_num(n)
    return s.lower()


def row_key(cells):
    return " ".join(k for k in (key_str(c) for c in cells) if k)


# ----------------------------------------------------------- alignment ----

def align_rows(S, tau=0.45):
    """Monotone alignment of truth rows (axis 0) to predicted rows (axis 1).

    S is a similarity matrix.  Maximises sum(S[i,j] - tau) over matched pairs with
    zero-cost gaps, so unmatched / extra rows are tolerated.  Returns [(i, j), ...].
    """
    n, m = S.shape
    if n == 0 or m == 0:
        return []
    gain = S.astype(np.float64) - tau
    gain[gain <= 0] = -1e9
    dp = np.zeros((n + 1, m + 1))
    for i in range(1, n + 1):
        a = np.maximum(dp[i - 1, 1:], dp[i - 1, :-1] + gain[i - 1])
        dp[i, 0] = 0.0
        dp[i, 1:] = a
        dp[i] = np.maximum.accumulate(dp[i])
    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        if dp[i, j] == dp[i - 1, j]:
            i -= 1
        elif dp[i, j] == dp[i, j - 1]:
            j -= 1
        else:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
    pairs.reverse()
    return pairs


# ------------------------------------------------------------ cell scores ----

def cell_score(tv, tt, pv):
    """Score predicted cell value pv against truth value tv of type tt.

    tt: 'n' number, 'p' percentage (tv is the fraction), 'd' ISO date string, 's' text.
    Returns (score in [0,1], stored_as_number or None).  Numbers must be numeric cells
    with the right value for full credit; the right value stored as text gets 0.5.
    """
    if tt in ("n", "p"):
        if is_number(pv):
            if close(float(pv), tv):
                return 1.0, True
            if tt == "p" and close(float(pv), tv * 100):
                return 0.5, True
            return 0.0, True
        if isinstance(pv, str) and pv.strip():
            n = parse_number(pv)
            if n is not None and (close(n, tv) or (tt == "p" and close(n, tv * 100))):
                return 0.5, False
            return 0.0, False
        return 0.0, None
    if tt == "d":
        td = _dt.date.fromisoformat(tv)
        if isinstance(pv, (_dt.datetime, _dt.date)):
            return (1.0 if parse_date(pv) == td else 0.0), None
        if is_number(pv):
            try:
                pd = _dt.date(1899, 12, 30) + _dt.timedelta(days=int(pv))
                return (0.5 if pd == td else 0.0), None
            except (OverflowError, ValueError):
                return 0.0, None
        if isinstance(pv, str) and pv.strip():
            return (0.5 if parse_date(pv) == td else 0.0), None
        return 0.0, None
    ts = norm_text(tv)
    ps = cell_str(pv)
    if ts == ps:
        return 1.0, None
    if ts.lower() == ps.lower():
        return 0.95, None
    return sim(ts, ps), None


def _guess_type(v):
    if is_number(v):
        return "n"
    return "s"


def compare_grids(truth_rows, pred_rows, truth_types=None, optional=None, tau=0.45,
                  truth_group=None, pred_group=None):
    """Compare a truth grid with a predicted grid.

    truth_rows / pred_rows: lists of rows (lists of values; None = empty).
    truth_types: parallel grid of 's','n','p','d','e' (inferred if None).
    optional: per-truth-row bool; optional rows are never counted missing/extra.
    truth_group / pred_group: per-row group ids (e.g. sheet index); the column mapping
    is solved separately for every (truth group, pred group) pair.

    Returns dict with 'pairs', 'colmap' {(tg,pg): {tc: pc}}, per-cell scores, etc.
    """
    from scipy.optimize import linear_sum_assignment

    nt, npred = len(truth_rows), len(pred_rows)
    if truth_types is None:
        truth_types = [[("e" if v in (None, "") else _guess_type(v)) for v in r] for r in truth_rows]
    optional = optional or [False] * nt
    truth_group = truth_group or [0] * nt
    pred_group = pred_group or [0] * npred
    tkeys = [row_key(r) for r in truth_rows]
    pkeys = [row_key(r) for r in pred_rows]
    S = sim_matrix(tkeys, pkeys)
    for i, k in enumerate(tkeys):
        if not k:
            S[i, :] = 0
    for j, k in enumerate(pkeys):
        if not k:
            S[:, j] = 0
    pairs = align_rows(S, tau)

    # column mapping per (truth group, pred group)
    groups = {}
    for i, j in pairs:
        groups.setdefault((truth_group[i], pred_group[j]), []).append((i, j))
    colmap = {}
    for g, gp in groups.items():
        ntc = max(len(truth_rows[i]) for i, _ in gp)
        npc = max(len(pred_rows[j]) for _, j in gp)
        if ntc == 0 or npc == 0:
            colmap[g] = {}
            continue
        C = np.zeros((ntc, npc))
        for i, j in gp:
            tr, pr, tt = truth_rows[i], pred_rows[j], truth_types[i]
            for tc in range(len(tr)):
                if tt[tc] == "e":
                    continue
                for pc in range(len(pr)):
                    if pr[pc] is None or pr[pc] == "":
                        continue
                    C[tc, pc] += cell_score(tr[tc], tt[tc], pr[pc])[0]
        r_ind, c_ind = linear_sum_assignment(-C)
        colmap[g] = {int(a): int(b) for a, b in zip(r_ind, c_ind) if C[a, b] > 0}

    matched = {i: j for i, j in pairs}
    cells = []  # (ti, tc, score, stored_as_number, pred_nonempty)
    spurious = 0
    for i, tr in enumerate(truth_rows):
        tt = truth_types[i]
        j = matched.get(i)
        cm = colmap.get((truth_group[i], pred_group[j]), {}) if j is not None else {}
        for tc, tv in enumerate(tr):
            if tt[tc] == "e":
                if j is not None and tc in cm:
                    pr = pred_rows[j]
                    pc = cm[tc]
                    if pc < len(pr) and pr[pc] not in (None, ""):
                        spurious += 1
                continue
            if j is None or tc not in cm:
                cells.append((i, tc, 0.0, None, False))
                continue
            pr = pred_rows[j]
            pc = cm[tc]
            pv = pr[pc] if pc < len(pr) else None
            sc, asnum = cell_score(tv, tt[tc], pv)
            cells.append((i, tc, sc, asnum, pv not in (None, "")))
    return {"pairs": pairs, "matched": matched, "colmap": colmap, "cells": cells,
            "spurious": spurious, "S": S, "tkeys": tkeys, "pkeys": pkeys}


def grid_cell_accuracy(truth_rows, pred_rows):
    """Mean cell score over all non-empty truth cells (missing rows score 0)."""
    tt = [[("e" if v in (None, "") else "s") for v in r] for r in truth_rows]
    tr = [[(None if v in (None, "") else str(v)) for v in r] for r in truth_rows]
    pr = [[(None if v in (None, "") else str(v)) for v in r] for r in pred_rows]
    res = compare_grids(tr, pr, tt)
    if not res["cells"]:
        return 1.0, res
    return sum(c[2] for c in res["cells"]) / len(res["cells"]), res


# --------------------------------------------------------- LibreOffice ----

def soffice_convert(srcs, outdir, fmt="pdf", timeout=300):
    """Convert files with LibreOffice headless (isolated profile). Returns list of outputs."""
    if isinstance(srcs, str):
        srcs = [srcs]
    os.makedirs(outdir, exist_ok=True)
    prof = tempfile.mkdtemp(prefix="lo_prof_")
    try:
        cmd = ["soffice", "-env:UserInstallation=file://" + prof, "--headless", "--norestore",
               "--convert-to", fmt, "--outdir", outdir] + list(srcs)
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
                       check=False)
    finally:
        shutil.rmtree(prof, ignore_errors=True)
    ext = fmt.split(":")[0]
    outs = []
    for s in srcs:
        o = os.path.join(outdir, os.path.splitext(os.path.basename(s))[0] + "." + ext)
        outs.append(o if os.path.exists(o) else None)
    return outs


def pdf_page_count(pdf):
    try:
        out = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"^Pages:\s+(\d+)", out, re.M)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


def render_pdf_gray(pdf, dpi=50, first=None, last=None):
    """Render PDF pages to greyscale numpy arrays (float32, 0..1) with pdftoppm."""
    from PIL import Image
    tmp = tempfile.mkdtemp(prefix="render_")
    try:
        cmd = ["pdftoppm", "-r", str(dpi), "-gray", "-png"]
        if first:
            cmd += ["-f", str(first)]
        if last:
            cmd += ["-l", str(last)]
        subprocess.run(cmd + [pdf, os.path.join(tmp, "p")], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=300, check=False)
        files = sorted(os.listdir(tmp), key=lambda f: int(re.findall(r"\d+", f)[-1]))
        return [np.asarray(Image.open(os.path.join(tmp, f)).convert("L"), dtype=np.float32) / 255.0
                for f in files]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def ssim(a, b):
    """Mean SSIM of two greyscale images (0..1 floats); b is resized to a's shape."""
    from PIL import Image
    from scipy.ndimage import gaussian_filter
    if a.shape != b.shape:
        b = np.asarray(Image.fromarray((b * 255).astype(np.uint8)).resize(
            (a.shape[1], a.shape[0]), Image.BILINEAR), dtype=np.float32) / 255.0
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mu_a, mu_b = gaussian_filter(a, 1.5), gaussian_filter(b, 1.5)
    saa = gaussian_filter(a * a, 1.5) - mu_a ** 2
    sbb = gaussian_filter(b * b, 1.5) - mu_b ** 2
    sab = gaussian_filter(a * b, 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2))
    return float(m.mean())


def ink_iou(a, b, thr=0.6):
    """IoU of 'ink' (dark) pixels after a 1-px dilation; more sensitive than SSIM on mostly-white pages."""
    from PIL import Image
    from scipy.ndimage import binary_dilation
    if a.shape != b.shape:
        b = np.asarray(Image.fromarray((b * 255).astype(np.uint8)).resize(
            (a.shape[1], a.shape[0]), Image.BILINEAR), dtype=np.float32) / 255.0
    da, db = binary_dilation(a < thr), binary_dilation(b < thr)
    union = np.logical_or(da, db).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(da, db).sum() / union)


def f1(p, r):
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def rnd(x, n=4):
    if x is None:
        return None
    if isinstance(x, float):
        return round(x, n)
    return x

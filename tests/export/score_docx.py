#!/usr/bin/env python3
"""Score a converter's .docx output against a corpus truth file.

    python3 score_docx.py corpus/<case>.truth.json out.docx [--no-visual]

Both documents are read with docxread.py and flattened to a token stream in reading
order (body paragraphs and table-cell paragraphs; header/footer excluded; list markers,
auto-numbered or literal, included as one normalised token).  Tokens are aligned with an
LCS (Indel) alignment; most metrics are computed over that alignment.

Metrics (0..1 unless a count; None = not applicable to this case):
  score            headline, weighted mean of the applicable parts:
                   text .30, para_f1 .10, heading_f1 .10, format .10, align .05, markers .05,
                   tables .10, images .05, header_footer .05, visual .10
                   (text = text_sim_char for scanned cases, text_sim otherwise)
  text_sim         word-level sequence similarity of the whole document (lower-cased,
                   edge punctuation stripped)
  text_sim_char    character-level similarity of the whole text (case-sensitive) - OCR friendly
  para_f1          paragraph-boundary F1 over aligned words (a boundary = last word of a paragraph)
  heading_f1       truth headings (Title / Heading N / outline level) vs predicted headings;
                   heading_level_acc = right level among detected ones
  bold_f1, italic_f1, underline_f1, superscript_f1, format_acc (all four flags equal) over aligned words;
                   format = mean of the F1s for attributes that occur in the truth
  align_acc        paragraph alignment (left/center/right/justify) of non-table, non-RTL paragraphs;
                   justify == left for short (< 80 char) paragraphs, which render identically
  marker_acc       list markers (1.1.2, (a), bullet, 1.) preserved, auto-numbered or literal
  table_acc        mean cell accuracy of each truth table vs its best-matching predicted table
  images_ok        min/max of truth vs predicted picture count
  header_sim, footer_sim  page header/footer text similarity (digits ignored);
                   furniture_in_body = body paragraphs that are really page headers/footers
  pages_src, pages_out, visual_ssim (mean per source page, 50 dpi grey; missing pages = 0),
                   visual_ink_iou  - the .docx is rendered with LibreOffice
  arabic_sim, rtl_ok  for documents with Arabic text
"""
import json
import os
import re
import shutil
import string
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import docxread  # noqa: E402
import evalcore as E  # noqa: E402

_EDGE = string.punctuation + "“”‘’«»…،؛؟"
ARABIC = re.compile(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")
PAGE_RE = re.compile(r"\bpage\s*\d*\s*(of|/)\s*\d*\b", re.I)


def norm_tok(w):
    t = E.norm_text(w).lower()
    s = t.strip(_EDGE)
    return s if s else t


def stream(paras):
    """Flatten paragraphs into tokens. Returns dict of parallel lists + per-block info."""
    toks, raw, flags, blk = [], [], [], []
    blocks = []
    for bi, p in enumerate(paras):
        start = len(toks)
        words = p["words"]
        lit = bool(p["marker"]) and not p["auto"]
        if p["auto"] and p["marker"]:
            m = docxread.norm_marker(p["marker"])
            if m:
                toks.append(m)
                raw.append(m)
                flags.append(None)
                blk.append(bi)
        for k, (w, f) in enumerate(words):
            if k == 0 and lit:
                t = docxread.norm_marker(p["marker"]) or norm_tok(w)
                # literal marker may be glued to the first word only via whitespace split
                if norm_tok(w) != norm_tok(p["marker"]):
                    t = norm_tok(w)
                    fl = f
                else:
                    fl = None
            else:
                t = norm_tok(w)
                fl = f
            if not t:
                continue
            toks.append(t)
            raw.append(E.norm_text(w))
            flags.append(fl)
            blk.append(bi)
        blocks.append((start, len(toks)))
    return {"toks": toks, "raw": raw, "flags": flags, "blk": blk, "blocks": blocks}


def _strip_digits(s):
    return E.norm_ws(re.sub(r"\d+", "", E.norm_text(s).lower()))


def visual_compare(ref_pdf, out_docx, dpi=50):
    tmp = tempfile.mkdtemp(prefix="vis_")
    try:
        src = os.path.join(tmp, "out.docx")
        shutil.copy(out_docx, src)
        pdf = E.soffice_convert([src], tmp, "pdf", timeout=180)[0]
        if not pdf:
            return {"pages_out": 0, "visual_ssim": 0.0, "visual_ink_iou": 0.0, "visual_error": "render failed"}
        a = E.render_pdf_gray(ref_pdf, dpi)
        b = E.render_pdf_gray(pdf, dpi)
        ss, ii = [], []
        for k in range(len(a)):
            if k < len(b):
                ss.append(E.ssim(a[k], b[k]))
                ii.append(E.ink_iou(a[k], b[k]))
            else:
                ss.append(0.0)
                ii.append(0.0)
        return {"pages_out": len(b), "visual_ssim": sum(ss) / len(ss) if ss else 0.0,
                "visual_ink_iou": sum(ii) / len(ii) if ii else 0.0}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def score_docx(truth, out_path, corpus_dir=None, visual=True):
    corpus_dir = corpus_dir or E.CORPUS
    pred = docxread.read_docx(out_path)
    tp, pp = truth["paragraphs"], pred["paragraphs"]
    ts, ps = stream(tp), stream(pp)
    scanned = bool(truth.get("scanned"))

    text_sim = E.seq_ratio(ts["toks"], ps["toks"])
    text_sim_char = E.sim(" ".join(ts["raw"]), " ".join(ps["raw"]))
    pairs = E.seq_matches(ts["toks"], ps["toks"])
    t2p = dict(pairs)

    t_end = [False] * len(ts["toks"])
    p_end = [False] * len(ps["toks"])
    for s, e in ts["blocks"]:
        if e > s:
            t_end[e - 1] = True
    for s, e in ps["blocks"]:
        if e > s:
            p_end[e - 1] = True
    tp_b = sum(1 for i, j in pairs if t_end[i] and p_end[j])
    np_b = sum(1 for i, j in pairs if p_end[j])
    nt_b = sum(1 for i, j in pairs if t_end[i])
    para_f1 = E.f1(tp_b / np_b if np_b else 0.0, tp_b / nt_b if nt_b else 0.0) if pairs else 0.0

    # paragraph mapping truth block -> best pred block
    tmap = {}
    for bi, (s, e) in enumerate(ts["blocks"]):
        if e <= s:
            continue
        counts = {}
        for i in range(s, e):
            j = t2p.get(i)
            if j is not None:
                counts[ps["blk"][j]] = counts.get(ps["blk"][j], 0) + 1
        if counts:
            pb, c = max(counts.items(), key=lambda kv: kv[1])
            if c * 2 >= (e - s):
                tmap[bi] = pb

    body = [bi for bi, p in enumerate(tp) if p["table"] is None]
    # headings
    th = [bi for bi in body if tp[bi]["level"] > 0]
    ph = {bi for bi, p in enumerate(pp) if p["level"] > 0}
    if th:
        hit = [bi for bi in th if tmap.get(bi) in ph]
        matched_ph = {tmap[bi] for bi in hit}
        hp = len(matched_ph) / len(ph) if ph else 0.0
        hr = len(hit) / len(th)
        heading_f1 = E.f1(hp, hr)
        heading_level_acc = (sum(1 for bi in hit if pp[tmap[bi]]["level"] == tp[bi]["level"]) / len(hit)
                             if hit else 0.0)
    else:
        heading_f1 = heading_level_acc = None

    # formatting over aligned words
    attrs = {"b": "bold", "i": "italic", "u": "underline", "^": "superscript"}
    cnt = {a: [0, 0, 0] for a in attrs}  # tp, fp, fn
    same = tot = 0
    for i, j in pairs:
        ft, fp_ = ts["flags"][i], ps["flags"][j]
        if ft is None or fp_ is None:
            continue
        tot += 1
        if set(ft) == set(fp_):
            same += 1
        for a in attrs:
            x, y = a in ft, a in fp_
            if x and y:
                cnt[a][0] += 1
            elif y:
                cnt[a][1] += 1
            elif x:
                cnt[a][2] += 1
    # truth positives that were not aligned at all count as misses
    for i, f in enumerate(ts["flags"]):
        if f and i not in t2p:
            for a in attrs:
                if a in f:
                    cnt[a][2] += 1
    fm = {}
    for a, name in attrs.items():
        t_, f_, n_ = cnt[a]
        if t_ + n_ == 0:
            fm[name + "_f1"] = None
        else:
            fm[name + "_f1"] = E.f1(t_ / (t_ + f_) if t_ + f_ else 0.0, t_ / (t_ + n_))
    fvals = [v for v in fm.values() if v is not None]
    fmt_score = sum(fvals) / len(fvals) if fvals else None
    format_acc = same / tot if tot else 0.0

    # alignment
    al = [bi for bi in body if not tp[bi]["rtl"]]
    ok = 0
    for bi in al:
        pb = tmap.get(bi)
        if pb is None:
            continue
        ta, pa = tp[bi]["align"], pp[pb]["align"]
        if len(tp[bi]["text"]) < 80:
            ta = "left" if ta == "justify" else ta
            pa = "left" if pa == "justify" else pa
        ok += ta == pa
    align_acc = ok / len(al) if al else None

    # markers
    ml = [bi for bi in body if tp[bi]["marker"]]
    mk = sum(1 for bi in ml if tmap.get(bi) is not None and
             docxread.norm_marker(pp[tmap[bi]]["marker"]) == docxread.norm_marker(tp[bi]["marker"]))
    marker_acc = mk / len(ml) if ml else None
    auto_used = sum(1 for bi in ml if tmap.get(bi) is not None and pp[tmap[bi]]["auto"])

    # tables
    ttabs = [t for t in truth.get("tables", []) if any(any(c for c in r) for r in t)]
    ptabs = [t for t in pred["tables"] if t and any(any(c for c in r) for r in t)]
    tab_scores = []
    used = set()
    for tt in ttabs:
        tjoin = E.norm_text(" ".join(c for r in tt for c in r if c))
        best, bj = -1.0, None
        for k, pt in enumerate(ptabs):
            if k in used:
                continue
            s = E.sim(tjoin, E.norm_text(" ".join(c for r in pt for c in r if c)))
            if s > best:
                best, bj = s, k
        if bj is None or best < 0.3:
            tab_scores.append(0.0)
            continue
        used.add(bj)
        acc, _ = E.grid_cell_accuracy(tt, ptabs[bj])
        tab_scores.append(acc)
    table_acc = sum(tab_scores) / len(tab_scores) if tab_scores else None

    # images
    ti, pi = truth.get("images", 0), pred["images"]
    images_ok = None if ti == 0 and pi == 0 else (min(ti, pi) / max(ti, pi))

    # header / footer
    hs = []
    hdr_sim = ftr_sim = None
    if truth.get("header"):
        hdr_sim = E.sim(_strip_digits(truth["header"]), _strip_digits(pred["header"]))
        hs.append(hdr_sim)
    if truth.get("footer"):
        ftr_sim = E.sim(_strip_digits(truth["footer"]), _strip_digits(pred["footer"]))
        hs.append(ftr_sim)
    hf = sum(hs) / len(hs) if hs else None
    furn = [_strip_digits(x) for x in (truth.get("header"), truth.get("footer")) if x]
    def _nfurn(paras):
        n = 0
        for p in paras:
            if p["table"] is not None:
                continue
            sd = _strip_digits(p["text"])
            if (PAGE_RE.search(p["text"]) and len(p["text"]) < 40) or any(E.sim(sd, f) >= 0.85 for f in furn):
                n += 1
        return n
    # body paragraphs that look like page header/footer text, beyond those genuinely in the body
    furn_body = max(0, _nfurn(pp) - _nfurn(tp))

    # arabic / rtl
    t_ar = " ".join(w for w in ts["raw"] if ARABIC.search(w))
    arabic_sim = rtl_ok = None
    if t_ar:
        p_ar = " ".join(w for w in ps["raw"] if ARABIC.search(w))
        arabic_sim = E.sim(t_ar, p_ar)
        rl = [bi for bi in body if tp[bi]["rtl"]]
        rtl_ok = (sum(1 for bi in rl if tmap.get(bi) is not None and pp[tmap[bi]]["rtl"]) / len(rl)) if rl else None

    vis = {}
    if visual:
        ref = os.path.join(corpus_dir, truth.get("visual_ref") or truth["case"] + ".pdf")
        vis = visual_compare(ref, out_path)
    pages_src = truth.get("pdf_pages")

    text_part = text_sim_char if scanned else text_sim
    parts = [(0.30, text_part), (0.10, para_f1), (0.10, heading_f1), (0.10, fmt_score), (0.05, align_acc),
             (0.05, marker_acc), (0.10, table_acc), (0.05, images_ok), (0.05, hf),
             (0.10, vis.get("visual_ssim") if visual else None)]
    tw = sum(w for w, v in parts if v is not None)
    score = sum(w * v for w, v in parts if v is not None) / tw

    out = {
        "score": score, "text_sim": text_sim, "text_sim_char": text_sim_char, "para_f1": para_f1,
        "paras_truth": len(tp), "paras_pred": len(pp),
        "heading_f1": heading_f1, "heading_level_acc": heading_level_acc,
        **fm, "format": fmt_score, "format_acc": format_acc,
        "align_acc": align_acc, "marker_acc": marker_acc, "markers_auto": auto_used, "markers_truth": len(ml),
        "table_acc": table_acc, "tables_truth": len(ttabs), "tables_pred": len(ptabs),
        "images_truth": ti, "images_pred": pi, "images_ok": images_ok,
        "header_sim": hdr_sim, "footer_sim": ftr_sim, "header_footer": hf, "furniture_in_body": furn_body,
        "arabic_sim": arabic_sim, "rtl_ok": rtl_ok,
        "pages_src": pages_src,
    }
    out.update(vis)
    return {k: E.rnd(v) for k, v in out.items()}


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("truth")
    ap.add_argument("out")
    ap.add_argument("--no-visual", action="store_true", help="skip the LibreOffice render / SSIM check")
    a = ap.parse_args()
    with open(a.truth, encoding="utf-8") as f:
        truth = json.load(f)
    m = score_docx(truth, a.out, corpus_dir=os.path.dirname(os.path.abspath(a.truth)), visual=not a.no_visual)
    print(json.dumps(m, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Run a PDF -> XLSX/DOCX converter over the corpus, score every case, summarise.

    python3 tests/export/run.py --conv "node tests/export/convert.mjs {in} {out}" --label mine
    python3 tests/export/run.py --conv "python3 tests/export/baselines/plumber_xlsx.py {in} {out}" \\
        --label plumber --kind xlsx
    options: --only 'boq_*' (fnmatch, or a plain substring)  --kind xlsx|docx  --timeout 300
             --jobs N (parallel cases)  --no-visual (skip docx render/SSIM)  --compare LABEL

{in} is the case PDF, {out} the output path (extension .xlsx or .docx = the requested
format).  The command runs through the shell with the repository root as working directory.
A non-zero exit code, a timeout or a missing/unreadable output counts as a failure (score 0).
Writes tests/export/results/<label>.json (per-case metrics, per-group averages) and keeps the
outputs in tests/export/results/<label>/.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import fnmatch
import glob
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evalcore as E  # noqa: E402
from score_docx import score_docx  # noqa: E402
from score_xlsx import score_xlsx  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
CORPUS = os.path.join(HERE, "corpus")
RESULTS = os.path.join(HERE, "results")
GROUP_ORDER = ["boq", "tbl", "qs", "doc", "scan"]

XLSX_KEYS = ["score", "cell_acc", "row_f1", "numeric_as_number", "header_ok", "desc_one_cell", "rows_extra",
             "rows_missing", "furniture_rows"]
DOCX_KEYS = ["score", "text_sim", "text_sim_char", "para_f1", "heading_f1", "format", "align_acc", "marker_acc",
             "table_acc", "images_ok", "header_footer", "visual_ssim"]


def load_cases(only=None, kind=None):
    cases = []
    for p in sorted(glob.glob(os.path.join(CORPUS, "*.truth.json"))):
        with open(p, encoding="utf-8") as f:
            t = json.load(f)
        name = t["case"]
        if kind and t["kind"] != kind:
            continue
        if only:
            pats = only.split(",")
            if not any(fnmatch.fnmatch(name, x) if any(ch in x for ch in "*?[") else x in name for x in pats):
                continue
        cases.append(t)
    cases.sort(key=lambda t: (GROUP_ORDER.index(t["group"]) if t["group"] in GROUP_ORDER else 99, t["case"]))
    return cases


def run_one(t, conv, outdir, timeout, visual):
    name, kind = t["case"], t["kind"]
    pdf = os.path.join(CORPUS, name + ".pdf")
    out = os.path.join(outdir, name + "." + kind)
    if os.path.exists(out):
        os.remove(out)
    cmd = conv.replace("{in}", shlex.quote(pdf)).replace("{out}", shlex.quote(out))
    rec = {"case": name, "group": t["group"], "kind": kind, "scanned": bool(t.get("scanned")), "ok": False,
           "error": None, "seconds": None, "metrics": {"score": 0.0}}
    t0 = time.time()
    try:
        p = subprocess.Popen(cmd, shell=True, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
        try:
            so, se = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.communicate()
            rec["seconds"] = round(time.time() - t0, 2)
            rec["error"] = "timeout after %ss" % timeout
            return rec
        rec["seconds"] = round(time.time() - t0, 2)
        if p.returncode != 0:
            rec["error"] = "exit %d: %s" % (p.returncode, (se or b"").decode("utf-8", "replace")[-400:].strip())
            return rec
        if not os.path.exists(out) or os.path.getsize(out) == 0:
            rec["error"] = "no output file"
            return rec
    except Exception as ex:  # pragma: no cover
        rec["seconds"] = round(time.time() - t0, 2)
        rec["error"] = "launch failed: %s" % ex
        return rec
    try:
        if kind == "xlsx":
            m = score_xlsx(t, out)
        else:
            m = score_docx(t, out, corpus_dir=CORPUS, visual=visual)
        rec["metrics"] = m
        rec["ok"] = True
    except Exception as ex:
        rec["error"] = "unreadable output / scoring failed: %s: %s" % (type(ex).__name__, str(ex)[:200])
        rec["traceback"] = traceback.format_exc()[-1500:]
    return rec


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def aggregate(recs):
    groups = {}
    for r in recs:
        groups.setdefault(r["group"], []).append(r)
    out = {}
    for g in sorted(groups, key=lambda g: GROUP_ORDER.index(g) if g in GROUP_ORDER else 99):
        rs = groups[g]
        a = {"n": len(rs), "failures": sum(1 for r in rs if not r["ok"]),
             "score": _mean([r["metrics"].get("score", 0.0) for r in rs]),
             "seconds": _mean([r["seconds"] for r in rs])}
        for kind, keys in (("xlsx", XLSX_KEYS), ("docx", DOCX_KEYS)):
            ok = [r for r in rs if r["kind"] == kind and r["ok"]]
            for k in keys[1:]:
                v = _mean([r["metrics"].get(k) for r in ok])
                if v is not None:
                    a[k] = v
        out[g] = a
    for kind in ("xlsx", "docx"):
        rs = [r for r in recs if r["kind"] == kind]
        if rs:
            out["ALL_" + kind] = {"n": len(rs), "failures": sum(1 for r in rs if not r["ok"]),
                                  "score": _mean([r["metrics"].get("score", 0.0) for r in rs]),
                                  "seconds": _mean([r["seconds"] for r in rs])}
    return out


def f2(v, w=4):
    if v is None:
        return " " * (w - 1) + "-"
    if isinstance(v, float):
        return ("%.2f" % v).rjust(w)
    return str(v).rjust(w)


def line_for(r, prev=None):
    m = r["metrics"]
    head = "%-18s %-4s %-4s %6s  %5s" % (r["case"], r["kind"], "ok" if r["ok"] else "FAIL",
                                        ("%.1fs" % r["seconds"]) if r["seconds"] is not None else "-",
                                        "%.3f" % m.get("score", 0.0))
    if prev is not None:
        d = m.get("score", 0.0) - prev
        head += " (%+.3f)" % d
    if not r["ok"]:
        return head + "  " + (r["error"] or "")[:90].replace("\n", " ")
    if r["kind"] == "xlsx":
        return head + "  cell %s rowF1 %s num %s hdr %s/%s 1cell %s  +%d -%d rows furn %d" % (
            f2(m["cell_acc"]), f2(m["row_f1"]), f2(m["numeric_as_number"]), m["header_count"], m["header_ideal"],
            f2(m["desc_one_cell"]), m["rows_extra"], m["rows_missing"], m["furniture_rows"])
    return head + "  text %s/%s para %s head %s fmt %s algn %s mark %s tab %s img %s/%s hf %s pg %s/%s ssim %s" % (
        f2(m["text_sim"]), f2(m["text_sim_char"]), f2(m["para_f1"]), f2(m["heading_f1"]), f2(m["format"]),
        f2(m["align_acc"]), f2(m["marker_acc"]), f2(m["table_acc"]), m["images_pred"], m["images_truth"],
        f2(m["header_footer"]), m.get("pages_out", "-"), m["pages_src"], f2(m.get("visual_ssim")))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--conv", required=True, help='command template with {in} and {out}')
    ap.add_argument("--label", required=True)
    ap.add_argument("--only", help="case filter: fnmatch pattern(s) or substring(s), comma separated")
    ap.add_argument("--kind", choices=["xlsx", "docx"])
    ap.add_argument("--timeout", type=float, default=300)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--no-visual", action="store_true")
    ap.add_argument("--compare", help="label of an earlier run to show score deltas against")
    a = ap.parse_args()

    cases = load_cases(a.only, a.kind)
    if not cases:
        sys.exit("no cases match (did you run make_corpus.py?)")
    outdir = os.path.join(RESULTS, a.label)
    os.makedirs(outdir, exist_ok=True)
    prev = {}
    if a.compare:
        with open(os.path.join(RESULTS, a.compare + ".json"), encoding="utf-8") as f:
            prev = {k: v["metrics"].get("score", 0.0) for k, v in json.load(f)["cases"].items()}

    t0 = time.time()
    recs = []
    print("%-18s %-4s %-4s %6s  %5s" % ("case", "kind", "", "time", "score"), flush=True)
    with cf.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = [ex.submit(run_one, t, a.conv, outdir, a.timeout, not a.no_visual) for t in cases]
        for fu in futs:
            r = fu.result()
            recs.append(r)
            print(line_for(r, prev.get(r["case"])), flush=True)

    groups = aggregate(recs)
    print("\n%-8s %3s %4s %7s %7s  averages over successful cases" % ("group", "n", "fail", "score", "sec"))
    for g, v in groups.items():
        extra = "  ".join("%s %s" % (k, f2(v[k])) for k in v if k not in ("n", "failures", "score", "seconds"))
        pv = ""
        if prev:
            ps = [prev[r["case"]] if r["case"] in prev else 0.0 for r in recs
                  if r["group"] == g or g == "ALL_" + r["kind"]]
            if ps:
                pv = " (%+.3f)" % (v["score"] - sum(ps) / len(ps))
        print("%-8s %3d %4d %7.3f %7s%s  %s" % (g, v["n"], v["failures"], v["score"],
                                               ("%.1f" % v["seconds"]) if v["seconds"] is not None else "-", pv,
                                               extra))
    res = {"label": a.label, "conv": a.conv, "date": dt.datetime.now().isoformat(timespec="seconds"),
           "only": a.only, "kind": a.kind, "wall_seconds": round(time.time() - t0, 1),
           "rapidfuzz": E.HAVE_RAPIDFUZZ, "groups": groups, "cases": {r["case"]: r for r in recs}}
    path = os.path.join(RESULTS, a.label + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1, default=str)
    print("\nwrote %s (%.0fs)" % (os.path.relpath(path, ROOT), time.time() - t0))


if __name__ == "__main__":
    main()

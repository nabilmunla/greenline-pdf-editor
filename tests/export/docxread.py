"""Minimal, dependency-light .docx reader used for BOTH ground truth and predictions.

Reads the package with zipfile + lxml (not python-docx) so it tolerates unusual
converter output.  Produces, in reading (document) order:

  paragraphs: [{text, marker, auto, level, align, rtl, table, words}]
      text   - paragraph text (NFKC-normalised, superscript digits folded to digits)
      marker - list marker text: rendered auto-numbering (auto=True) or a literal
               leading marker such as '1.1.2', '(a)', '•' (auto=False, part of text)
      level  - heading level (1-9) from 'Heading N'/'Title' style or outline level; 0 = body
      align  - left | center | right | justify (style chain resolved; logical for RTL)
      rtl    - paragraph has w:bidi
      table  - [table_index, row, col] for paragraphs inside table cells, else None
      words  - [[word, flags]] where flags contains b/i/u/^ (bold/italic/underline/superscript)
  tables: [grid]  (grid = list of rows of cell text; merged continuation cells are '')
  images, header, footer
Empty paragraphs are dropped.
"""
import re
import sys
import unicodedata
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {
    "w": W,
    "r": R,
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "v": "urn:schemas-microsoft-com:vml",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
MC_ALT = "{%s}AlternateContent" % NS["mc"]
MC_CHOICE = "{%s}Choice" % NS["mc"]
MC_FALLBACK = "{%s}Fallback" % NS["mc"]


def q(tag):
    return "{%s}%s" % (W, tag)


SUPERSCRIPT_CHARS = {"²": "2", "³": "3", "¹": "1", "⁰": "0", "⁴": "4",
                     "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9"}
BULLETS = set("•●▪■◦○·‣⁃▪●∙"
              "-–—*➢►✓▶➤")
LIT_MARK = re.compile(
    r"^\s*((?:\d+\.)+\d*|\d+\)|\(\d+\)|\([a-zA-Z]\)|[a-zA-Z][.)](?=\s)|\([ivxlcIVXLC]+\)|"
    r"[ivxlcIVXLC]+\)|[•●▪■◦○·\-–—*➢►✓▶➤])(?=\s|$)")


def norm_marker(m):
    m = (m or "").strip()
    if not m:
        return ""
    if len(m) == 1 and m in BULLETS:
        return "•"
    m = m.strip("()").rstrip(".").strip()
    return m.lower()


def _onoff(el):
    if el is None:
        return None
    v = el.get(q("val"))
    return v not in ("0", "false", "off", "none")


def _val(el, default=None):
    if el is None:
        return default
    return el.get(q("val"), default)


class Styles:
    def __init__(self, root):
        self.by_id = {}
        self.default_para = None
        self.default_char = None
        self.doc_rpr = None
        self.doc_ppr = None
        if root is None:
            return
        for st in root.findall(q("style")):
            sid = st.get(q("styleId"))
            self.by_id[sid] = st
            if st.get(q("default")) in ("1", "true") and st.get(q("type")) == "paragraph":
                self.default_para = sid
        dd = root.find(q("docDefaults"))
        if dd is not None:
            self.doc_rpr = dd.find("%s/%s" % (q("rPrDefault"), q("rPr")))
            self.doc_ppr = dd.find("%s/%s" % (q("pPrDefault"), q("pPr")))

    def chain(self, sid):
        seen = 0
        while sid and sid in self.by_id and seen < 20:
            st = self.by_id[sid]
            yield st
            sid = _val(st.find(q("basedOn")))
            seen += 1

    def name(self, sid):
        st = self.by_id.get(sid)
        if st is None:
            return sid or ""
        return _val(st.find(q("name")), sid) or ""


class Numbering:
    FMT = {}

    def __init__(self, root):
        self.abstract = {}
        self.nums = {}
        self.counters = {}
        self.started = set()
        if root is None:
            return
        for an in root.findall(q("abstractNum")):
            aid = an.get(q("abstractNumId"))
            lv = {}
            for l in an.findall(q("lvl")):
                il = int(l.get(q("ilvl"), "0"))
                lv[il] = (_val(l.find(q("numFmt")), "decimal"), _val(l.find(q("lvlText")), ""),
                          int(_val(l.find(q("start")), "1") or 1))
            self.abstract[aid] = lv
        for n in root.findall(q("num")):
            nid = n.get(q("numId"))
            aid = _val(n.find(q("abstractNumId")))
            ov = {}
            for o in n.findall(q("lvlOverride")):
                so = o.find(q("startOverride"))
                if so is not None:
                    ov[int(o.get(q("ilvl"), "0"))] = int(_val(so, "1"))
            self.nums[nid] = (aid, ov)

    @staticmethod
    def _fmt(n, fmt):
        if fmt in ("lowerLetter", "upperLetter"):
            s = ""
            k = n
            while k > 0:
                k, r = divmod(k - 1, 26)
                s = chr(97 + r) + s
            return s.upper() if fmt == "upperLetter" else s
        if fmt in ("lowerRoman", "upperRoman"):
            vals = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"),
                    (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
            s, k = "", n
            for v, t in vals:
                while k >= v:
                    s += t
                    k -= v
            return s.upper() if fmt == "upperRoman" else s
        if fmt == "decimalZero":
            return "%02d" % n
        if fmt == "none":
            return ""
        return str(n)

    def marker(self, nid, ilvl):
        if nid not in self.nums:
            return ""
        aid, ov = self.nums[nid]
        lv = self.abstract.get(aid, {})
        if ilvl not in lv:
            return ""
        cnt = self.counters.setdefault(aid, {})
        if nid not in self.started:
            self.started.add(nid)
            for il, st in ov.items():
                cnt[il] = st - 1
        fmt, text, start = lv[ilvl]
        cnt[ilvl] = cnt.get(ilvl, start - 1) + 1
        for deeper in list(cnt):
            if deeper > ilvl:
                del cnt[deeper]
        if fmt == "bullet":
            return text or "•"

        def rep(m):
            k = int(m.group(1)) - 1
            f, _, st = lv.get(k, ("decimal", "", 1))
            return self._fmt(cnt.get(k, st), f)
        return re.sub(r"%(\d)", rep, text)


class DocxReader:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = set(self.z.namelist())
        self.styles = Styles(self._xml("word/styles.xml"))
        self.numbering = Numbering(self._xml("word/numbering.xml"))
        self.paragraphs = []
        self.tables = []

    def _xml(self, name):
        if name not in self.names:
            return None
        try:
            return etree.fromstring(self.z.read(name), etree.XMLParser(huge_tree=True, recover=True))
        except Exception:
            return None

    # ---- property resolution ----
    def _ppr_chain(self, p):
        ppr = p.find(q("pPr"))
        out = []
        if ppr is not None:
            out.append(ppr)
        sid = _val(ppr.find(q("pStyle"))) if ppr is not None else None
        sid = sid or self.styles.default_para
        for st in self.styles.chain(sid):
            sp = st.find(q("pPr"))
            if sp is not None:
                out.append(sp)
        if self.styles.doc_ppr is not None:
            out.append(self.styles.doc_ppr)
        return out, sid

    def _rpr_chain(self, r, psid):
        rpr = r.find(q("rPr"))
        out = []
        if rpr is not None:
            out.append(rpr)
            rs = _val(rpr.find(q("rStyle")))
            for st in self.styles.chain(rs):
                sp = st.find(q("rPr"))
                if sp is not None:
                    out.append(sp)
        for st in self.styles.chain(psid):
            sp = st.find(q("rPr"))
            if sp is not None:
                out.append(sp)
        if self.styles.doc_rpr is not None:
            out.append(self.styles.doc_rpr)
        return out

    @staticmethod
    def _first(chain, tag):
        for el in chain:
            x = el.find(q(tag))
            if x is not None:
                return x
        return None

    def _run_flags(self, r, psid):
        ch = self._rpr_chain(r, psid)
        b = _onoff(self._first(ch, "b")) or False
        i = _onoff(self._first(ch, "i")) or False
        u_el = self._first(ch, "u")
        u = u_el is not None and _val(u_el, "single") != "none"
        va = _val(self._first(ch, "vertAlign"), "baseline")
        pos = _val(self._first(ch, "position"), "0")
        try:
            pos = int(float(pos))
        except ValueError:
            pos = 0
        sup = va == "superscript" or pos >= 2
        return b, i, u, sup

    # ---- traversal ----
    def _runs(self, el):
        for ch in el:
            t = ch.tag
            if t == q("r"):
                yield ch
            elif t in (q("del"), q("pPr"), q("moveFrom"), q("rPr")):
                continue
            elif t == MC_ALT:
                c = ch.find(MC_CHOICE)
                if c is not None:
                    yield from self._runs(c)
            elif isinstance(t, str):
                yield from self._runs(ch)

    def _run_content(self, r, out_chars, flags, textboxes):
        for ch in r:
            t = ch.tag
            if t == q("t"):
                for c in ch.text or "":
                    out_chars.append((c, flags))
            elif t in (q("tab"), q("ptab")):
                out_chars.append(("\t", flags))
            elif t in (q("br"), q("cr")):
                out_chars.append(("\n", flags))
            elif t == q("noBreakHyphen"):
                out_chars.append(("-", flags))
            elif t == q("sym"):
                try:
                    out_chars.append((chr(int(ch.get(q("char")), 16)), flags))
                except (TypeError, ValueError):
                    pass
            elif t in (q("drawing"), q("pict"), q("object")):
                textboxes.extend(ch.iter(q("txbxContent")))
            elif t == MC_ALT:
                c = ch.find(MC_CHOICE)
                if c is not None:
                    for sub in c:
                        if sub.tag in (q("drawing"), q("pict")):
                            textboxes.extend(sub.iter(q("txbxContent")))

    def _paragraph(self, p, table=None, sink=None):
        sink = self.paragraphs if sink is None else sink
        pprs, psid = self._ppr_chain(p)
        chars = []
        textboxes = []
        for r in self._runs(p):
            fl = self._run_flags(r, psid)
            self._run_content(r, chars, fl, textboxes)
        # numbering
        auto_marker = ""
        numpr = self._first(pprs, "numPr")
        if numpr is not None:
            nid = _val(numpr.find(q("numId")))
            il = int(_val(numpr.find(q("ilvl")), "0") or 0)
            if nid and nid != "0":
                auto_marker = self.numbering.marker(nid, il)
        # heading level
        level = 0
        for st in self.styles.chain(psid):
            nm = (_val(st.find(q("name")), "") or "").strip().lower()
            m = re.fullmatch(r"heading\s*(\d)", nm)
            if m:
                level = int(m.group(1))
                break
            if nm == "title":
                level = 1
                break
        if level == 0:
            ol = self._first(pprs, "outlineLvl")
            if ol is not None:
                try:
                    v = int(_val(ol, "9"))
                    if v < 9:
                        level = v + 1
                except ValueError:
                    pass
        jc = _val(self._first(pprs, "jc"), "left")
        align = {"left": "left", "start": "left", "right": "right", "end": "right",
                 "center": "center", "both": "justify", "distribute": "justify",
                 "thaiDistribute": "justify", "lowKashida": "justify", "mediumKashida": "justify",
                 "highKashida": "justify"}.get(jc, "left")
        rtl = bool(_onoff(self._first(pprs, "bidi")))
        # normalise characters
        nchars = []
        for c, fl in chars:
            if c in SUPERSCRIPT_CHARS:
                nchars.append((SUPERSCRIPT_CHARS[c], (fl[0], fl[1], fl[2], True)))
                continue
            for cc in unicodedata.normalize("NFKC", c):
                if cc in "‎‏‪‫‬‭‮⁦⁧⁨⁩﻿­​":
                    continue
                if cc in "   ":
                    cc = " "
                nchars.append((cc, fl))
        text = re.sub(r"\s+", " ", "".join(c for c, _ in nchars)).strip()
        words = []
        cur = []
        for c, fl in nchars + [(" ", None)]:
            if c.isspace():
                if cur:
                    w = "".join(x for x, _ in cur)
                    n = len(cur)
                    b = sum(1 for _, f in cur if f[0]) * 2 >= n
                    i = sum(1 for _, f in cur if f[1]) * 2 >= n
                    u = sum(1 for _, f in cur if f[2]) * 2 >= n
                    s = any(f[3] for _, f in cur)
                    words.append([w, ("b" if b else "") + ("i" if i else "") + ("u" if u else "") +
                                  ("^" if s else "")])
                    cur = []
            else:
                cur.append((c, fl))
        marker = auto_marker
        auto = bool(auto_marker)
        if not auto and text:
            m = LIT_MARK.match(text)
            if m:
                marker = m.group(1)
        if text:
            sink.append({"text": text, "marker": marker, "auto": auto, "level": level, "align": align,
                         "rtl": rtl, "table": table, "words": words})
        for tb in textboxes:
            self._container(tb, table=table, sink=sink)

    def _table(self, tbl, sink=None):
        ti = len(self.tables)
        self.tables.append(None)
        grid = []
        for ri, tr in enumerate(tbl.findall(q("tr"))):
            row = []
            trpr = tr.find(q("trPr"))
            if trpr is not None:
                gb = trpr.find(q("gridBefore"))
                if gb is not None:
                    row.extend([""] * int(_val(gb, "0") or 0))
            for tc in self._cells(tr):
                tcpr = tc.find(q("tcPr"))
                span = 1
                cont = False
                if tcpr is not None:
                    gs = tcpr.find(q("gridSpan"))
                    if gs is not None:
                        span = max(1, int(_val(gs, "1") or 1))
                    vm = tcpr.find(q("vMerge"))
                    if vm is not None and _val(vm, "continue") != "restart":
                        cont = True
                ci = len(row)
                cell_paras = []
                if not cont:
                    self._container(tc, table=[ti, ri, ci], sink=cell_paras)
                else:
                    # continuation cells normally hold an empty paragraph; keep any text anyway
                    self._container(tc, table=[ti, ri, ci], sink=cell_paras)
                (self.paragraphs if sink is None else sink).extend(cell_paras)
                txt = " ".join(p["text"] for p in cell_paras if p["table"] == [ti, ri, ci])
                row.append(txt)
                row.extend([""] * (span - 1))
            grid.append(row)
        self.tables[ti] = grid

    def _cells(self, tr):
        for ch in tr:
            if ch.tag == q("tc"):
                yield ch
            elif ch.tag in (q("sdt"), q("customXml")):
                for sub in ch.iter(q("tc")):
                    yield sub
                    break

    def _container(self, el, table=None, sink=None):
        for ch in el:
            t = ch.tag
            if t == q("p"):
                self._paragraph(ch, table=table, sink=sink)
            elif t == q("tbl"):
                self._table(ch, sink=sink)
            elif t in (q("sdt"), q("sdtContent"), q("customXml"), q("ins")):
                self._container(ch, table=table, sink=sink)
            elif t == MC_ALT:
                c = ch.find(MC_CHOICE)
                if c is not None:
                    self._container(c, table=table, sink=sink)

    def _rels(self, part):
        d, f = part.rsplit("/", 1)
        root = self._xml("%s/_rels/%s.rels" % (d, f))
        out = {}
        if root is None:
            return out
        for rel in root.findall("{%s}Relationship" % NS["rel"]):
            tgt = rel.get("Target", "")
            if not tgt.startswith("/"):
                tgt = d + "/" + tgt
            out[rel.get("Id")] = tgt.lstrip("/")
        return out

    def _hf_text(self, root_doc, kind):
        rels = self._rels("word/document.xml")
        texts = []
        seen = set()
        for ref in root_doc.iter(q(kind + "Reference")):
            part = rels.get(ref.get("{%s}id" % R))
            if not part or part in seen:
                continue
            seen.add(part)
            hroot = self._xml(part)
            if hroot is None:
                continue
            sub = DocxReader.__new__(DocxReader)
            sub.z, sub.names, sub.styles, sub.numbering = self.z, self.names, self.styles, Numbering(None)
            sub.paragraphs, sub.tables = [], []
            sub._container(hroot)
            t = " ".join(p["text"] for p in sub.paragraphs)
            if t and t not in texts:
                texts.append(t)
        return " | ".join(texts)

    def _count_images(self):
        n = 0
        parts = ["word/document.xml"] + sorted(x for x in self.names if re.match(r"word/(header|footer)\d*\.xml$", x))
        for part in parts:
            root = self._xml(part)
            if root is None:
                continue
            n += len(root.xpath("//pic:pic[not(ancestor::mc:Fallback)]", namespaces=NS))
            n += len(root.xpath("//v:imagedata[not(ancestor::mc:Fallback)]", namespaces=NS))
        return n

    def read(self):
        root = self._xml("word/document.xml")
        if root is None:
            raise ValueError("no word/document.xml")
        body = root.find(q("body"))
        self._container(body)
        return {
            "paragraphs": self.paragraphs,
            "tables": self.tables,
            "images": self._count_images(),
            "header": self._hf_text(root, "header"),
            "footer": self._hf_text(root, "footer"),
        }


def read_docx(path):
    return DocxReader(path).read()


if __name__ == "__main__":
    import json
    d = read_docx(sys.argv[1])
    for p in d["paragraphs"]:
        print(json.dumps({k: p[k] for k in ("marker", "auto", "level", "align", "rtl", "table")}),
              p["text"][:90])
    print("tables", [len(t) for t in d["tables"]], "images", d["images"])
    print("header:", d["header"])
    print("footer:", d["footer"])

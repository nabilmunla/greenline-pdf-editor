# PDF → Excel / Word export: evaluation harness

Measures how well a PDF → `.xlsx` / `.docx` converter handles the documents our users
(tendering engineers in Dubai) actually convert: BOQs, schedules, specifications,
contract conditions, letters — some of them scanned.

```
tests/export/
  make_corpus.py      builds corpus/ (deterministic, ~30 s)
  corpus_text.py      BOQ items, spec clauses, letter text, Arabic text used by make_corpus
  corpus/             <case>.pdf  <case>.truth.json  <case>.xlsx|.docx (the generating document)
  score_xlsx.py       truth.json + out.xlsx -> metrics JSON
  score_docx.py       truth.json + out.docx -> metrics JSON (renders the docx with LibreOffice)
  run.py              runs a converter over every case, scores, writes results/<label>.json
  evalcore.py         shared: normalisation, number/date parsing, row alignment, grid compare, SSIM
  docxread.py         .docx reader used for BOTH truth extraction and scoring
  baselines/          plumber_xlsx.py (pdfplumber), pdf2docx_docx.py (pdf2docx)
  results/            <label>.json + <label>/ (converter outputs)
```

Requirements: python3 with reportlab, openpyxl, python-docx, numpy, scipy, Pillow, lxml,
img2pdf, matplotlib; `rapidfuzz` (strongly recommended — without it a slow difflib
fallback is used); LibreOffice (`soffice`) and poppler (`pdftoppm`, `pdfinfo`).
Baselines additionally need `pdfplumber` and `pdf2docx`
(`pip install --break-system-packages rapidfuzz pdf2docx pdfplumber`).

## Regenerate the corpus

```
python3 tests/export/make_corpus.py              # everything, ~30 s
python3 tests/export/make_corpus.py --only 'boq_*'   # subset (fnmatch)
python3 tests/export/make_corpus.py --no-scan    # skip the scanned variants
```

Seeds are fixed: truth JSON is byte-identical between runs (PDF/xlsx/docx differ only in
embedded timestamps). Spreadsheets are written with openpyxl (print titles = repeated
header row, page header with project/bill name, `Page &P of &N` footer, manual page
breaks, A4, fit-to-width) and printed by LibreOffice; Word documents by python-docx →
LibreOffice; `qs_*` are drawn directly with reportlab; `scan_*` rasterise another case,
stamp it, rotate it, add noise and wrap the JPEGs into an image-only PDF (no text layer).

## Cases (26)

| case | out | pages | what it exercises |
|---|---|---|---|
| `boq_allborders` | xlsx | 2 | priced BOQ, every cell boxed, letter refs A, B, C (I/O skipped) |
| `boq_vlines` | xlsx | 3 | **vertical lines only** (most common), unpriced, refs `4.1 … 4.10 …` stored as text |
| `boq_noborders` | xlsx | 1 | no borders at all, top-aligned (qty on first line), lump sums (Item/LS/Sum), partly priced |
| `boq_landscape` | xlsx | 2 | landscape, extra Spec-Ref and Remarks columns, numeric refs |
| `boq_negative` | xlsx | 1 | variation statement, negative qty/amount shown as `(1,234.00)` |
| `boq_twolevel` | xlsx | 1 | two-level merged header: RATE over Labour / Material |
| `boq_long` | xlsx | 11 | header row repeated on every page, manual breaks, page totals "Total Carried to Collection", collection page |
| `boq_twobills` | xlsx | 2 | two sheets (Bill 3, Bill 4) printed as one PDF — ideal output keeps one header per bill |
| `boq_summary` | xlsx | 1 | grand summary: % share, contingency, VAT, large AED amounts |
| `tbl_doors` | xlsx | 2 | door schedule: 14 cols, 7 pt, shaded two-level header, merged group rows, vertically merged remarks |
| `tbl_payments` | xlsx | 1 | dates (`15-Jan-2026`), percentages, `AED 1,234.00` currency format, negative retention |
| `tbl_comparison` | xlsx | 1 | subcontractor comparison: merged supplier headers, discounts %, variance %, text terms in number columns |
| `qs_lastline` | xlsx | 3 | QS-software printout: vertical column lines only, qty/unit/rate/amount on the LAST line of the description, Carried/Brought forward |
| `qs_firstline` | xlsx | 2 | same but qty/unit on the FIRST line, unpriced with dotted leaders in rate/amount |
| `qs_nolines` | xlsx | 2 | Courier printout with no column lines at all, page totals to collection, refs `5.01 … 5.10` |
| `doc_spec` | docx | 7 | specification: Title + Heading 1–3, literal `1.1.1⇥` clauses with hanging indents, Word bullets, b/i/u runs, m²/m³, a table, a figure, header + `Page X of Y` footer |
| `doc_letter` | docx | 2 | logo image, right-aligned date, centred bold-underlined subject, justified body, auto-numbered enclosures, signature block |
| `doc_twocol` | docx | 1 | single-column title then a two-column section (reading order: left column, then right) |
| `doc_arabic` | docx | 1 | English paragraphs alternating with RTL Arabic paragraphs, Arabic heading, mixed Arabic/Latin line |
| `doc_superscript` | docx | 1 | superscript runs (m², m³, N/mm², 1st) in text and table headers |
| `doc_justified` | docx | 2 | justified contract conditions, Heading 2 sub-clauses, `(a)/(b)/(c)` hanging items |
| `doc_minutes` | docx | 1 | minutes: key/value table, shaded headers, merged group rows, `4.1` items |
| `scan_boq_vlines` | xlsx | 3 | 200 dpi scan of `boq_vlines`, 0.7°, blue RECEIVED stamp p.1 |
| `scan_qs_lastline` | xlsx | 3 | 200 dpi scan of `qs_lastline`, −1.1°, red stamp p.2 |
| `scan_spec` | docx | 7 | 200 dpi scan of `doc_spec`, 0.4°, stamps p.1 and p.7 |
| `scan_letter` | docx | 2 | 300 dpi scan of `doc_letter`, −0.8°, red stamp |

Groups (used for averages): `boq`, `tbl`, `qs`, `doc`, `scan`.

### Truth format

All truth files share `case, kind (xlsx|docx), group, source (xlsx|docx|reportlab),
scanned, description, pdf_pages`; scans add `base, dpi, rotation_deg, stamped_pages`.

**xlsx cases** — `sheets[]`, one per bill/sheet: `rows` (cell grid, numbers as numbers,
dates as ISO strings, empty = null; merged cells hold the value in the top-left cell only),
`types` (`s` text, `n` number, `p` percentage stored as a fraction, `d` date, `e` empty),
`roles` per row (`title, blank, header, section, subsection, item, total, collection,
grand_total, cf, bf`), `lines` (estimated wrapped lines of the description), `header_rows`,
`repeat_rows` (rows printed at the top of every page), `columns` (role names: `ref, desc,
qty, unit, rate, amount, …`), and `optional_roles` (`cf`/`bf` — "Carried/Brought forward"
rows may be kept or dropped without penalty). `page_furniture` lists page header/footer
strings (`#` = a page number) that should NOT end up as rows. For `qs_*` the rows are what
a converter should produce: one row per item with the whole wrapped description joined.

**docx cases** — `paragraphs[]` in reading order (body and table cells; empty paragraphs
dropped): `text, marker, auto, level, align, rtl, table, words[[word, flags]]` where flags
⊂ `b i u ^` (bold, italic, underline, superscript); `tables[]` (cell grids of text),
`images`, `header`, `footer`, `visual_ref` (PDF used for the visual check — for scans, the
clean original). The truth is extracted from the generating .docx by `docxread.py`, the
same reader that reads the converter output, so both sides are interpreted identically.

## Running a converter

```
python3 tests/export/run.py --conv "node tests/export/convert.mjs {in} {out}" --label v1
python3 tests/export/run.py --conv "..." --label v1b --only 'boq_*,qs_*' --kind xlsx --compare v1
```

The command is run through the shell from the repository root. `{in}` is the PDF, `{out}`
the path to write; its extension (`.xlsx` / `.docx`) is the requested format. Each case
goes to the format of its truth (`kind`); `--kind` restricts to one. Exit code ≠ 0,
`--timeout` (default 300 s), no output, or an unreadable file = failure, score 0.
Other options: `--jobs N` (parallel cases), `--no-visual` (skip docx rendering, faster),
`--only` (comma-separated fnmatch patterns, or plain substrings: `qs_lastline` also matches
`scan_qs_lastline`), `--compare LABEL` (score deltas against an earlier run).

Score one file by hand:

```
python3 tests/export/score_xlsx.py tests/export/corpus/boq_vlines.truth.json out.xlsx --detail
python3 tests/export/score_docx.py tests/export/corpus/doc_spec.truth.json out.docx
```

`--detail` (xlsx; always included in results JSON) lists missing rows, extra rows and the
worst cells — the quickest way to see *why* a case scores low.

## Reading the results

`results/<label>.json`: `cases.<case>.metrics` (everything below), `ok/error/seconds`,
`groups` (averages per group, failures count 0 in `score`), `ALL_xlsx` / `ALL_docx`.
The stdout table prints one line per case and the group averages.

**xlsx** — truth rows (all sheets concatenated, blank rows dropped) are aligned to
predicted rows (all sheets concatenated) by a monotone sequence alignment on the
normalised text of the whole row (threshold 0.45), so extra/missing rows are tolerated
and counted; columns are then mapped per (truth sheet, predicted sheet) by maximum total
cell score, so column offsets or spare columns are harmless.

| metric | meaning |
|---|---|
| `score` | 0.45·`cell_acc` + 0.20·`row_f1` + 0.15·`numeric_as_number` + 0.10·`desc_one_cell` + 0.10·`header_ok` (n/a parts re-weighted) |
| `cell_acc` | mean score over all non-empty truth cells, missing rows = 0. Number: numeric cell with the right value 1.0, right value but stored as text 0.5. Percent stored as 5 instead of 0.05: 0.5. Date: date cell 1.0, date text 0.5. Text: 1.0 if equal after whitespace normalisation, else character similarity. `columns` gives it per column role |
| `row_f1`, `rows_missing`, `rows_extra` | row recovery (`cf`/`bf` rows optional) |
| `numeric_as_number` | of the numeric truth cells that have a non-empty predicted cell, share stored as numbers |
| `header_count/header_ideal`, `header_ok` | how often the column-header row appears; ideal = once per bill (`hdr 11/1` = repeated on every page) |
| `desc_one_cell` | wrapped (≥2-line) descriptions recovered as ONE cell |
| `furniture_rows` | page header/footer text that leaked into rows |
| `spurious_cells`, `formula_cells` | text in cells that should be empty; formulas (read back without cached values) |

**docx** — both documents are flattened to a token stream in reading order (list markers
included as one token, header/footer excluded) and aligned word by word (LCS).

| metric | meaning |
|---|---|
| `score` | weights: text .30, `para_f1` .10, `heading_f1` .10, `format` .10, `align_acc` .05, `marker_acc` .05, `table_acc` .10, `images_ok` .05, `header_footer` .05, `visual_ssim` .10 (n/a parts re-weighted; scanned cases use `text_sim_char` as text) |
| `text_sim` / `text_sim_char` | word-level / character-level similarity of the whole text |
| `para_f1` | paragraph-boundary F1 (soft line breaks inside a paragraph are fine; one paragraph per line is not) |
| `heading_f1`, `heading_level_acc` | headings must be real Heading/Title styles or outline levels — bold 14 pt body text does not count |
| `bold_f1 … superscript_f1`, `format`, `format_acc` | per-word formatting; `format` = mean F1 of attributes present in the truth. A smaller font run on the baseline is not a superscript |
| `align_acc` | paragraph alignment (RTL paragraphs excluded; justify = left for paragraphs < 80 chars) |
| `marker_acc` | list markers kept (auto-numbering or literal text both count) |
| `table_acc` | cell accuracy of each truth table vs the best-matching predicted table (text laid out with tabs is not a table) |
| `images_ok`, `header_footer`, `furniture_in_body` | picture count; header/footer text (digits ignored); header/footer text dumped into the body |
| `pages_out` vs `pages_src`, `visual_ssim`, `visual_ink_iou` | docx rendered by LibreOffice, 50 dpi grey, mean per source page (missing pages = 0). SSIM is forgiving on mostly-white pages (pdf2docx outputs span only 0.70–0.93); `visual_ink_iou` (IoU of dark pixels) spreads more (0.36–0.75) |
| `arabic_sim`, `rtl_ok` | Arabic text in logical order; RTL paragraphs marked bidi |

## Baselines (recorded 2026-10-27)

```
python3 tests/export/run.py --conv "python3 tests/export/baselines/plumber_xlsx.py {in} {out}" --label plumber --kind xlsx
python3 tests/export/run.py --conv "python3 tests/export/baselines/pdf2docx_docx.py {in} {out}" --label pdf2docx --kind docx
```

| group | plumber (xlsx) | pdf2docx (docx) |
|---|---|---|
| boq (9) | 0.411 | – |
| tbl (3) | 0.955 | – |
| qs (3) | 0.095 | – |
| doc (7) | – | 0.748 |
| scan | 0.000 (2) | 0.107 (2) |
| all | 0.403 (17) | 0.606 (9) |

pdfplumber is near-perfect when every cell is ruled (`boq_allborders`, `boq_negative`,
`boq_summary`, `tbl_*`) and collapses on vertical-lines-only and line-less layouts (each
page becomes one giant row), which is exactly the common BOQ case. pdf2docx keeps text
well (0.96) but detects no headings, no header/footer, merges list items and loses
justification and superscripts. Neither does OCR, so scans score ~0 (pdf2docx's 0.1 is
the page image plus visual similarity).

## Known limitations

- `lines` for spreadsheet cases is estimated from font metrics, not measured from the PDF;
  `desc_one_cell` may count a borderline 1-line description as multi-line or vice versa.
- Row alignment needs ~45 % text similarity; a description split into many rows is
  scored as one partially matching row plus extra rows.
- Alignment of RTL paragraphs is not scored (OOXML `jc` left/right is logical for bidi
  paragraphs and LibreOffice/Word differ); `rtl_ok` and `arabic_sim` cover Arabic instead.
- The visual check uses LibreOffice, not Word, to render the converter's .docx.
- Formulas without cached values read back as empty cells (`formula_cells` > 0 flags it).

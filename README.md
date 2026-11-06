<p align="center"><img src="public/icon256.png" width="112" alt=""></p>

# Greenline PDF Editor

### The PDF editor that doesn't choke on construction drawings.

500 MB merged drawing sets. A0 sheets traced from CAD with millions of lines. 1,500-page specifications. Scanned tender books. The files that make ordinary PDF editors freeze, run out of memory or quietly crash are the files Greenline was built for. Free, offline, open source.

## Why it exists

I'm an engineer in the tendering department of a main contractor. Every tender lands as a pile of huge PDFs, and I lost too many hours watching PDF programs hang on them. So I built one that doesn't: speed and stability came first, then the measuring and markup tools a tender needs.

It was built with **Claude 5.5** by Anthropic. I set the requirements and tested it on real tender files; Claude wrote the code.

## Numbers, not adjectives

| | |
|---|---|
| A 317 MB scanned book | opens in **under half a second** |
| A 46 MB sheet of 15 million pen strokes that almost no PDF program could open | opens and draws, simplified to 481 thousand strokes **with no visible change** |
| A 1.26 GB merged drawing set | saves in **about 6 seconds** |
| A drawing engine running out of memory on a monster page | **restarts by itself**; the window and your work carry on |

How: pages are read from disk only as they're needed, never the whole file at once. Drawing, editing and batch jobs each run in their own background engine, so one overloaded engine can't take the app down with it. An engine that dies is restarted with your file from its last automatic copy.

## What it does

- **Take-off measuring:** set the scale or calibrate on a known dimension, then length, area *with* perimeter, count, and count by tag (e.g. every D-01 door mark on a plan). Corners snap to the drawing; totals go straight to Excel.
- **Markups:** clouds, callouts, arrows and text boxes formatted like a word processor; stamps, including your own company seal from a scan.
- **Pages:** merge, extract, insert, reorder and rotate thousands of pages; combine files straight from Windows Explorer's right-click menu.
- **Scans:** OCR in English and Arabic, fully offline.
- **Export:** BOQs and schedules to Excel, documents to Word.
- **Print:** A0 sheets fitted onto A3 or A4, or at actual size for drawings to scale, with a preview of every sheet.
- **Optional:** an AI assistant (Claude or ChatGPT, with your own key) and an offline translator.

## Private by design

Your files never leave your PC. The only things that go online are update checks (here, on GitHub), the translator's one-off language download, and the AI assistant, only when you use it.

## Install

Windows 10/11. Download **PDF Editor Setup &lt;version&gt;.exe** from [Releases](https://github.com/nabilmunla/greenline-pdf-editor/releases/latest) and run it. No admin rights needed.

The setup isn't code-signed yet, so Windows may say "Windows protected your PC": click **More info**, then **Run anyway**.

New versions are announced inside the app (it asks before downloading anything). Every update is signed by the publisher and checked before it's installed. Found a problem? **File › Report a problem** opens a GitHub issue with your text filled in.

## Building from source

Needs Node.js 22, Python 3 (with Pillow), Go 1.24 and `rsvg-convert`.

```
npm ci
npm run build        # the app (dist/) and its background engines
npm test             # unit tests
node_modules/.bin/electron . --no-sandbox     # run it
python3 scripts/publish.py <out>              # Windows setup + update package
```

`publish.py` signs the update list with `keys/update-signing-key.pem`, which is not in this repository: make your own key pair for your own builds (`electron/updsig.cjs` holds the public key copies trust). The sample drawings and scans used by most end-to-end tests aren't published either.

## Licence

Free and open source under the **GNU Affero General Public License v3 or later** (see [LICENSE](LICENSE)). It has to be: the editing engine, [MuPDF](https://mupdf.com), is AGPL. You may use, change and share it; if you pass on a changed copy, pass its source with it. Every other part keeps its own licence: see `public/THIRD-PARTY-NOTICES.txt`.

<p align="center"><img src="public/icon256.png" width="112" alt=""></p>

# Greenline PDF Editor

**A PDF editor built for the files construction people actually open: 500 MB merged drawing sets, A0 sheets made of millions of lines, scanned tender books.**

## Why it exists

I'm a tendering engineer. My working day is huge construction PDFs, and the usual PDF programs hang, run out of memory or crash on them. Greenline was built to do one thing first: open those files fast and keep working, whatever is thrown at it. The measuring and markup tools a tender needs came after.

## How it stays standing

- **Pages are read from disk as they're needed**, never the whole file at once, so a 300 MB scan book opens in about a second.
- **Drawing, editing and batch jobs run in separate background engines.** If a monster page knocks one over, it restarts by itself and the window carries on. Your file comes back from its last automatic copy.
- **Sheets made of millions of tiny strokes** (traced drawings, some CAD exports) are simplified on opening. They look the same and become workable.

## What it does

- **Measure:** set the scale (or calibrate), then length, area *with* perimeter, count, and count by tag (door marks, for example). Totals go straight to Excel.
- **Mark up:** clouds, callouts, text boxes formatted like a word processor, stamps (including your own seal from a scan), with snapping to the drawing.
- **Pages:** merge, extract, insert and reorder thousands of pages. Combine files from Windows Explorer's right-click menu.
- **Scans:** OCR in English and Arabic, offline.
- **Export:** BOQs and schedules to Excel, documents to Word.
- **Print:** big sheets on A3/A4, to scale or fitted, with a preview.
- **Optional:** an AI assistant (Claude or ChatGPT, with your own key) and an offline translator.

## Private by design

Your files never leave your PC. The only things that go online are update checks (here, on GitHub), the translator's one-off language download, and the AI assistant, but only when you use it.

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

# Writes public/THIRD-PARTY-NOTICES.txt (shown in Settings > About > Licences, shipped in the app):
# the licence situation of PDF Editor and the licence of every open-source part inside it.
#   python3 scripts/notices.py
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NM = os.path.join(ROOT, 'node_modules')
GOROOT = subprocess.run(['go', 'env', 'GOROOT'], capture_output=True, text=True).stdout.strip()
TP = os.path.join(ROOT, 'installer', 'third_party')

def read(*p):
    with open(os.path.join(*p), encoding='utf-8', errors='replace') as f:
        return f.read().strip()

parts = [
    # (name, what it does here, licence, file with the licence text)
    ('MuPDF (mupdf.js)', 'editing engine: markups, pages, saving', 'GNU Affero General Public License v3 or later', (NM, 'mupdf', 'LICENSE')),
    ('PDFium (via @embedpdf/pdfium)', 'drawing pages, text, search', 'BSD-3-Clause / Apache-2.0 (PDFium); MIT (wrapper)', (NM, '@embedpdf/pdfium', 'LICENSE.pdfium')),
    ('@embedpdf/pdfium', 'PDFium build for the web', 'MIT', (NM, '@embedpdf/pdfium', 'LICENSE')),
    ('Tesseract OCR (tesseract.js, tesseract.js-core)', 'making scans searchable', 'Apache License 2.0', (NM, 'tesseract.js', 'LICENSE.md')),
    ('tesseract.js-core', 'Tesseract compiled for the web', 'Apache License 2.0', (NM, 'tesseract.js-core', 'LICENSE')),
    ('Tesseract language data (English, Arabic)', 'OCR languages', 'Apache License 2.0 (tessdata); packaged by tesseract.js-data (MIT)', None),
    ('Bergamot translator (Mozilla)', 'offline translation engine', 'Mozilla Public License 2.0 - source: https://github.com/mozilla/translations', None),
    ('Firefox Translations models and engine build (Mozilla)', 'the translator\'s language files - not included: downloaded from Mozilla\'s servers the first time a language is used', 'Mozilla Public License 2.0 - https://github.com/mozilla/firefox-translations-models', None),
    ('React, React DOM, Scheduler', 'the interface', 'MIT', (NM, 'react', 'LICENSE')),
    ('fflate', 'zip files', 'MIT', (NM, 'fflate', 'LICENSE')),
    ('HarfBuzz (harfbuzzjs)', 'shaping Arabic and other scripts in text', 'MIT (harfbuzzjs); HarfBuzz itself: MIT ("Old MIT") - https://github.com/harfbuzz/harfbuzz/blob/main/COPYING', (NM, 'harfbuzzjs', 'LICENSE')),
    ('bidi-js', 'right-to-left text order', 'MIT', (NM, 'bidi-js', 'LICENSE.txt')),
    ('Inter (font)', 'interface font', 'SIL Open Font License 1.1', (NM, '@fontsource-variable/inter', 'LICENSE')),
    ('Electron (Chromium, Node.js)', 'the app runtime', 'MIT (Electron); Chromium and Node.js licences: LICENSE and LICENSES.chromium.html in the app folder', None),
    ('PDF Editor Setup: Go standard library', 'installer and updater', 'BSD-3-Clause', (GOROOT, 'LICENSE')),
    ('PDF Editor Setup: golang.org/x/sys', 'Windows functions', 'BSD-3-Clause', (TP, 'sys', 'LICENSE')),
    ('PDF Editor Setup: go-webview2', 'the setup window', 'MIT', (TP, 'go-webview2', 'LICENSE')),
    ('PDF Editor Setup: go-winloader', 'loading WebView2Loader', 'MIT', (TP, 'go-winloader', 'LICENSE.md')),
    ('PDF Editor Setup: WebView2Loader (Microsoft)', 'starting Edge WebView2', 'Microsoft WebView2 SDK licence (BSD-style)', (TP, 'go-webview2', 'webviewloader', 'sdk', 'LICENSE.txt')),
    ('PDF Editor Setup: klauspost/compress', 'unpacking the app', 'BSD-3-Clause / Apache-2.0 / MIT parts', (TP, 'compress', 'LICENSE')),
]

# every runtime package in package.json is shipped, so it needs its entry above (a new one added
# without it stops here, instead of going out with its notice missing)
COVERED = {'mupdf', 'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng', '@tesseract.js-data/ara', 'fflate', 'harfbuzzjs', 'bidi-js'}
missing = sorted(set(json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8')).get('dependencies', {})) - COVERED)
if missing:
    sys.exit('notices.py: no licence entry for ' + ', '.join(missing) + ' - add it to the list')

out = []
out.append('PDF EDITOR - LICENCES\n=====================\n')
out.append('''PDF Editor is built on the open-source parts listed below. Each keeps its own licence.

MuPDF is licensed under the GNU Affero General Public License (AGPL) version 3 or later.
Because PDF Editor includes MuPDF, anyone who passes a copy of PDF Editor on to someone else
must also make its complete source code available under the same licence. The source code of
each version is kept as source-v<version>.zip next to the published app.
''')
out.append('\nPARTS\n-----\n')
for name, what, lic, _ in parts:
    out.append(f'- {name}: {what}.\n  Licence: {lic}\n')
out.append('\n\nLICENCE TEXTS\n=============\n')
seen = set()
for name, _, lic, f in parts:
    if not f:
        continue
    p = os.path.join(*f)
    if p in seen:
        continue
    # (a licence text that isn't where it should be stops the build - it went out without it before)
    if not os.path.exists(p):
        sys.exit(f'notices.py: licence text of {name} not found: {p}')
    seen.add(p)
    out.append('\n' + '-' * 78 + '\n' + name + '\n' + '-' * 78 + '\n\n' + read(p) + '\n')
dst = os.path.join(ROOT, 'public', 'THIRD-PARTY-NOTICES.txt')
open(dst, 'w', encoding='utf-8').write(''.join(out))
print(dst, os.path.getsize(dst) // 1024, 'KB', len(seen), 'licence texts')

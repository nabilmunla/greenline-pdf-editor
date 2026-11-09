# App payload (resources\app) + source snapshot as zips.  python3 scripts/pack.py <outdir>
import zipfile, os, json, sys
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
pkg = json.load(open('package.json'))
ver = pkg['version']
# what the app can't work without and the build doesn't make by itself (copy-assets.mjs, the engine
# bundles): missing -> no package at all, rather than an app that can't draw or OCR
need = ['dist/index.html', 'dist/pdfium.wasm', 'dist/glyphless.ttf', 'dist/ocr/worker.min.js', 'dist/ocr/lang/eng.traineddata.gz', 'dist/ocr/lang/ara.traineddata.gz', 'electron/engines/edit.mjs', 'electron/engines/render.mjs']
missing = [f for f in need if not os.path.isfile(f)] + ([] if os.path.isdir('dist/ocr/core') and any(f.endswith('.wasm.js') for f in os.listdir('dist/ocr/core')) else ['dist/ocr/core/*.wasm.js'])
if missing:
    sys.exit('pack.py: missing ' + ', '.join(missing) + ' - run node scripts/copy-assets.mjs, then npm run build')
# Explorer's "Combine with PDF Editor" runs this small program once per file (installer/combine):
# it comes with the app part, so with the app updates (resources\app\bin)
import subprocess, tempfile
comb_dir = tempfile.mkdtemp(prefix='pdfed-combine-')
comb = os.path.join(comb_dir, 'PDF Editor Combine.exe')
genv = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0', GOPROXY='off', GOFLAGS='-mod=mod', GOTOOLCHAIN='local', GOSUMDB='off')
subprocess.run(['go', 'build', '-trimpath', '-ldflags', f'-s -w -H windowsgui -X main.version={ver}', '-o', comb, './combine'], cwd='installer', env=genv, check=True)
subprocess.run(['node', os.path.join('installer', 'patch-res.mjs'), comb, os.path.join('pack', 'app.ico'), ver, (pkg.get('displayName') or 'PDF Editor') + ' Combine', 'PDF Editor Combine.exe'], check=True, stdout=subprocess.DEVNULL)
app = os.path.join(out, f'app-v{ver}.zip')
with zipfile.ZipFile(app, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.write(comb, 'bin/PDF Editor Combine.exe')
    for root, _, files in os.walk('dist'):
        for f in files:
            p = os.path.join(root, f); z.write(p, p)
    for f in os.listdir('electron'):
        if f.endswith('.cjs'): z.write(os.path.join('electron', f), 'electron/' + f)
    # engine processes (+ MuPDF next to them)
    for root, _, files in os.walk('electron/engines'):
        for f in files: z.write(os.path.join(root, f), os.path.join(root, f).replace(os.sep, '/'))
    # (updateFeed / reportEndpoint: where the public build looks for new versions when no updates
    # folder is set, and where its anonymous reports go; the company build has neither)
    z.writestr('package.json', json.dumps({'name': pkg['name'], 'productName': pkg['productName'], 'version': ver, 'main': 'electron/main.cjs', 'private': True, **{k: pkg[k] for k in ('updateFeed', 'reportEndpoint', 'displayName', 'brand') if pkg.get(k)}}, indent=2))
src = os.path.join(out, f'source-v{ver}.zip')
# no sample drawings or documents of any kind go out with the source (tests/data, tests/real...),
# no build output, no git folders (also inside installer/third_party)
skip = ('node_modules', 'dist', 'tests/real', 'tests/data', 'tests/scratch', 'tests/tmp', 'tests/tmp2', 'tests/huge', 'tests/out', 'tests/export/results', 'public/ocr', 'electron/engines', 'pack/out', 'build', 'keys')
# (the output folder itself when it is inside the source - the zips would go into the source zip)
outRel = os.path.relpath(os.path.abspath(out), os.path.abspath('.')).replace(os.sep, '/')
with zipfile.ZipFile(src, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        r = os.path.relpath(root, '.').replace(os.sep, '/')
        if '.git' in r.split('/') or any(r == s or r.startswith(s + '/') for s in skip) or r.startswith('tests/tmp') or r.startswith('tests/agent'): continue
        if not outRel.startswith('..') and (r == outRel or r.startswith(outRel + '/')): continue
        for f in files:
            p = os.path.join(root, f)
            if r.startswith('tests') and (f.lower().endswith(('.pdf', '.jpg', '.png', '.xlsx', '.docx')) or f.startswith('tmp-')): continue
            if r == 'public' and f in ('pdfium.wasm', 'glyphless.ttf'): continue
            if r == '.' and f in ('NOTES.md',): continue  # internal working notes
            z.write(p, os.path.relpath(p, '.').replace(os.sep, '/'))
# the update signing key must never leave the developer copy (the source zip goes onto the share)
with zipfile.ZipFile(src) as z:
    for n in z.namelist():
        assert not n.startswith('keys/') and (b'-----BEGIN ' + b'PRIVATE KEY-----') not in z.read(n), 'signing key found in the source zip: ' + n
import shutil; shutil.rmtree(comb_dir, ignore_errors=True)
print(app, os.path.getsize(app) // 1024, 'KB'); print(src, os.path.getsize(src) // 1024, 'KB')

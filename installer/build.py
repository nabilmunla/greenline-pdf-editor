# Build "PDF Editor Setup <version>.exe": the setup program + the whole app (Electron runtime +
# resources\app) compressed inside it.
#   python3 installer/build.py <electron-win32-x64.zip> <app-vX.zip> <outdir>
# Needs: Go (cross-compiles for Windows), node + resedit (npm i), python zstandard.
import atexit, base64, io, json, os, shutil, struct, subprocess, sys, tarfile, zipfile
import zstandard

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ez, az, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
ver = pkg['version']
# the name people see (the public build's own; files and folders keep "PDF Editor") and where new
# versions come from when the setup isn't run from an updates folder
NAME = pkg.get('displayName') or pkg.get('productName') or 'PDF Editor'
FEED = pkg.get('updateFeed') or ''
runtime = os.path.basename(ez).split('-')[1].lstrip('v')  # electron-v44.5.1-win32-x64.zip
work = os.path.join(out, '_setup-build')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)
# (the ~330 MB staging folder goes whatever happens - a build that failed halfway left it inside
# the publish folder, which then gets copied to the share)
atexit.register(shutil.rmtree, work, True)

# 1. the page of the setup window, with the app's font and logo inside it
html = open(os.path.join(HERE, 'ui.src.html'), encoding='utf-8').read().replace('PDF Editor', NAME)
font = next(f for f in os.listdir(os.path.join(ROOT, 'dist', 'assets')) if f.startswith('inter-latin-wght-normal'))
html = html.replace('{{INTER}}', base64.b64encode(open(os.path.join(ROOT, 'dist', 'assets', font), 'rb').read()).decode())
html = html.replace('{{LOGO}}', base64.b64encode(open(os.path.join(ROOT, 'dist', 'gmark.svg'), 'rb').read()).decode())
open(os.path.join(HERE, 'ui.html'), 'w', encoding='utf-8').write(html)

# 2. the setup program (Windows, no console window)
stub = os.path.join(work, 'setup.exe')
env = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0', GOPROXY='off', GOFLAGS='-mod=mod', GOTOOLCHAIN='local', GOSUMDB='off')
subprocess.run(['go', 'build', '-trimpath', '-ldflags', f"-s -w -H windowsgui -X main.version={ver} -X 'main.displayName={NAME}'" + (f" -X 'main.defaultSource={FEED}'" if FEED else ''), '-o', stub, '.'], cwd=HERE, env=env, check=True)
ico = os.path.join(ROOT, 'pack', 'app.ico')
subprocess.run(['node', os.path.join(HERE, 'patch-res.mjs'), stub, ico, ver, NAME + ' Setup', 'PDF Editor Setup.exe', os.path.join(HERE, 'setup.manifest')], cwd=ROOT, check=True)

# 3. the app folder exactly as it will be installed
stage = os.path.join(work, 'app')
with zipfile.ZipFile(ez) as z:
    for m in z.infolist():
        if m.is_dir() or m.filename.endswith('default_app.asar'):
            continue
        name = 'PDF Editor.exe' if m.filename == 'electron.exe' else m.filename
        dst = os.path.join(stage, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with z.open(m) as s, open(dst, 'wb') as d:
            shutil.copyfileobj(s, d)
subprocess.run(['node', os.path.join(HERE, 'patch-res.mjs'), os.path.join(stage, 'PDF Editor.exe'), ico, ver, NAME, 'PDF Editor.exe'], cwd=ROOT, check=True)
with zipfile.ZipFile(az) as z:
    for m in z.infolist():
        if m.is_dir():
            continue
        dst = os.path.join(stage, 'resources', 'app', m.filename)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with z.open(m) as s, open(dst, 'wb') as d:
            shutil.copyfileobj(s, d)
app_ver = json.load(open(os.path.join(stage, 'resources', 'app', 'package.json')))['version']
assert app_ver == ver, f'app zip is {app_ver}, package.json says {ver}'

# 4. tar (sorted, plain names) compressed with zstd (long window: the runtime repeats a lot)
files = []
for r, _, fs in os.walk(stage):
    for f in fs:
        files.append(os.path.relpath(os.path.join(r, f), stage).replace(os.sep, '/'))
files.sort()
total = 0
tbuf = io.BytesIO()
with tarfile.open(fileobj=tbuf, mode='w', format=tarfile.GNU_FORMAT) as t:
    for rel in files:
        p = os.path.join(stage, rel)
        ti = tarfile.TarInfo(rel)
        ti.size = os.path.getsize(p)
        ti.mode = 0o644
        ti.mtime = 0
        total += ti.size
        with open(p, 'rb') as f:
            t.addfile(ti, f)
level = int(os.environ.get('SETUP_ZSTD_LEVEL', '19'))
params = zstandard.ZstdCompressionParameters.from_level(level, window_log=27, enable_ldm=True, threads=-1)
payload = zstandard.ZstdCompressor(compression_params=params).compress(tbuf.getvalue())
meta = json.dumps({'version': ver, 'runtime': runtime, 'total': total, 'files': len(files)}).encode()

# 5. program + payload + meta + trailer
setup = os.path.join(out, f'{NAME} Setup {ver}.exe')
with open(setup, 'wb') as o:
    o.write(open(stub, 'rb').read())
    o.write(payload)
    o.write(meta)
    o.write(struct.pack('<QQ', len(meta), len(payload)))
    o.write(b'PDFEDSET')
shutil.rmtree(work, ignore_errors=True)
print(setup, os.path.getsize(setup) // 1024, 'KB', f'({len(files)} files, {total // 2**20} MB installed, runtime {runtime})')

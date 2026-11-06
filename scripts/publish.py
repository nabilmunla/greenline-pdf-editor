# Everything for one version, ready to copy onto the company's updates folder:
#   publish-v<version>/  latest.json, app-v<version>.zip, PDF Editor Setup <version>.exe,
#                        source-v<version>.zip, HOW-TO-PUBLISH.txt
#   python3 scripts/publish.py <outdir>
# Needs a built dist/ (npm run build). Downloads the Windows Electron runtime once (checked
# against Electron's published SHA-256 list) into ~/.cache/pdfed.
import hashlib, json, os, re, shutil, subprocess, sys, urllib.request, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# (absolute: the build steps run from the source folder - a relative folder given from elsewhere
# had the zips and setup written into the source tree, then the script failed at the end)
out_root = os.path.abspath(sys.argv[1])
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
ver = pkg['version']
evr = json.load(open(os.path.join(ROOT, 'node_modules', 'electron', 'package.json')))['version']
# the signing key first (there, and the one the app trusts): found missing only after the whole
# build, it left a complete-looking folder with an unsigned latest.json
subprocess.run(['node', os.path.join(ROOT, 'scripts', 'sign-latest.mjs'), '--check'], cwd=ROOT, check=True)
out = os.path.join(out_root, f'publish-v{ver}')
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

# 1. the Windows runtime (same Electron version the app is built and tested with)
cache = os.path.expanduser('~/.cache/pdfed')
os.makedirs(cache, exist_ok=True)
ez = os.path.join(cache, f'electron-v{evr}-win32-x64.zip')
base = f'https://github.com/electron/electron/releases/download/v{evr}/'
sums = urllib.request.urlopen(base + 'SHASUMS256.txt').read().decode()
want = next(l.split()[0] for l in sums.splitlines() if l.strip().endswith(f'*electron-v{evr}-win32-x64.zip'))
if not os.path.exists(ez) or sha(ez) != want:
    print('downloading Electron', evr)
    urllib.request.urlretrieve(base + f'electron-v{evr}-win32-x64.zip', ez)
assert sha(ez) == want, 'Electron download does not match its published checksum'

# the README names the version and the setup file: kept in step with package.json (0.5.0 went
# out first with "0.4.0" in it)
readme = os.path.join(ROOT, 'README.txt')
rt = open(readme, encoding='utf-8').read()
rt2 = re.sub(r'^(PDF EDITOR - version )\d+\.\d+\.\d+', lambda m: m.group(1) + ver, rt, count=1, flags=re.M)
rt2 = re.sub(r'PDF Editor Setup \d+\.\d+\.\d+\.exe', f'PDF Editor Setup {ver}.exe', rt2)
if rt2 != rt:
    open(readme, 'w', encoding='utf-8').write(rt2)
    print('README version set to', ver)

# 2. licences file, app update package + source
subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'notices.py')], check=True)
# (the drawing engine's wasm, the OCR worker + languages and the OCR font come from node_modules
# into public/ - not part of "npm run build", and not in the source zip: a fresh source tree
# published an app that could neither draw nor OCR)
subprocess.run(['node', os.path.join('scripts', 'copy-assets.mjs')], cwd=ROOT, check=True)
subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'pack.py'), out], cwd=ROOT, check=True)
# 3. the setup
subprocess.run([sys.executable, os.path.join(ROOT, 'installer', 'build.py'), ez, os.path.join(out, f'app-v{ver}.zip'), out], cwd=ROOT, check=True)

app = os.path.join(out, f'app-v{ver}.zip')
setup = os.path.join(out, f'PDF Editor Setup {ver}.exe')
notes = json.load(open(os.path.join(ROOT, 'release-notes.json'), encoding='utf-8')).get(ver, [])
# grouped notes ({"New features": [...], "General polishing": [...], "Fixes": [...]}) from 0.6.0 on;
# copies up to 0.5.0 read only the flat "notes" list: the new features first, then the fixes
groups = notes if isinstance(notes, dict) else None
# (up to 6 lines: the first new features and the first fixes, then polishing if there's room)
def flat_of(g):
    pick = lambda k, n: [x for name, xs in g.items() if name.lower().startswith(k) for x in xs][:n]
    out = pick('new', 3) + pick('fix', 3)
    return (out + pick('general', 6))[:6]
flat = notes if isinstance(notes, list) else flat_of(notes)
latest = {
    'version': ver,
    'runtime': evr,
    'published': datetime.date.today().isoformat(),
    'notes': flat,
    **({'groups': groups} if groups else {}),
    'app': {'file': os.path.basename(app), 'sha256': sha(app), 'size': os.path.getsize(app)},
    # (no "setup" entry from 0.8.3 on: copies up to 0.8.2 fetched the setup named here into AppData
    # and started it when the runtime changed - Sophos stopped that as malicious behaviour. Without
    # it they find no package for a new runtime and say nothing; 0.8.3+ show "run the setup", by
    # its usual name, from this folder)
}
# signed with the publisher's key: installed copies (0.8.2 on) take nothing from the updates folder
# that isn't (electron/updsig.cjs). The key is keys/update-signing-key.pem - never in a zip.
# (written under another name and signed there: latest.json is never in the folder unsigned)
unsigned = os.path.join(out, 'latest.json.unsigned')
with open(unsigned, 'w') as f:
    json.dump(latest, f, indent=2)
try:
    subprocess.run(['node', os.path.join(ROOT, 'scripts', 'sign-latest.mjs'), unsigned], cwd=ROOT, check=True)
except BaseException:
    os.remove(unsigned)
    raise
os.replace(unsigned, os.path.join(out, 'latest.json'))
open(os.path.join(out, 'HOW-TO-PUBLISH.txt'), 'w').write(f'''PDF Editor {ver} - publishing

1. Copy into the updates folder on the share (e.g. \\\\server\\Software\\PDF Editor):
     app-v{ver}.zip
     PDF Editor Setup {ver}.exe
     source-v{ver}.zip
   and LAST:
     latest.json
   Installed copies see the new version once latest.json is there, and ask their users.
   Then remove the older versions' files from the folder (a PDF Editor left open since
   before could still fetch them - 0.8.2's setup was flagged by the antivirus that way).

2. New PCs: run "PDF Editor Setup {ver}.exe" from that folder - the setup then uses
   the folder for updates by itself.

To hold a version back: don't copy latest.json yet (or put the previous one back).

latest.json is signed (copies from 0.8.2 on check it): don't edit it by hand - an edited
one is refused. The signing key stays with the developer copy, never on the share.
''')
# for people outside the company (testers): one zip with the setup, the guides and the source
import zipfile
tester = os.path.join(out_root, f'PDF Editor {ver} (test copy).zip')
note = open(os.path.join(ROOT, 'installer', 'ALPHA-TEST.txt'), encoding='utf-8').read().replace('{{VERSION}}', ver)
with zipfile.ZipFile(tester, 'w') as z:
    folder = f'PDF Editor {ver}/'
    z.write(setup, folder + os.path.basename(setup), compress_type=zipfile.ZIP_STORED)
    z.write(os.path.join(ROOT, 'README.txt'), folder + 'README.txt', compress_type=zipfile.ZIP_DEFLATED)
    z.writestr(folder + 'START HERE.txt', note.replace('\n', '\r\n'), compress_type=zipfile.ZIP_DEFLATED)
    z.write(os.path.join(out, f'source-v{ver}.zip'), folder + f'source-v{ver}.zip', compress_type=zipfile.ZIP_STORED)
print('\n'.join(f'{f}  {os.path.getsize(os.path.join(out, f)) // 1024} KB' for f in sorted(os.listdir(out))))
print(tester, os.path.getsize(tester) // 1024, 'KB')

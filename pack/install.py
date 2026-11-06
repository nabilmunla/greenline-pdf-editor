# Build the portable app folder on the PC from the Electron runtime + the app payload.
# python3 install.py <electron-zip> <app-payload-zip> <target-folder>
# then: node patch-exe.mjs "<target-folder>\PDF Editor.exe" app.ico   (icon + the app's version)
import sys, os, zipfile, json
ez, az, target = sys.argv[1:4]
os.makedirs(target, exist_ok=True)
# the runtime is unpacked again when it is another Electron zip than last time, or the last unpack
# didn't finish (the marker is written last) - an exe being there said nothing about the rest
marker = os.path.join(target, 'runtime.txt')
want = f'{os.path.basename(ez)} {os.path.getsize(ez)}'
have = open(marker, encoding='utf-8').read().strip() if os.path.exists(marker) else ''
if have != want:
    with zipfile.ZipFile(ez) as z:
        for m in z.infolist():
            if m.is_dir() or m.filename.endswith('default_app.asar'):
                continue
            name = 'PDF Editor.exe' if m.filename == 'electron.exe' else m.filename
            out = os.path.join(target, name)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(m) as src, open(out, 'wb') as dst:
                dst.write(src.read())
    open(marker, 'w', encoding='utf-8').write(want)
    print('runtime unpacked (the exe is new: run patch-exe.mjs again)')
app = os.path.join(target, 'resources', 'app')
n = 0
names = set()
with zipfile.ZipFile(az) as z:
    for m in z.infolist():
        if m.is_dir():
            continue
        names.add(os.path.normcase(os.path.normpath(m.filename)))
        out = os.path.join(app, m.filename)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        # overwrite in place (this shell may not delete files)
        with z.open(m) as src, open(out, 'wb') as dst:
            dst.write(src.read())
        n += 1
    version = json.loads(z.read('package.json')).get('version', '?')
print('app files written:', n)
# files of an earlier version this one doesn't have (old bundles, old engines): left in place, the
# copy would run a mixture of versions - removed, or listed when this shell may not delete them
stale = []
for root, _, files in os.walk(app):
    for f in files:
        rel = os.path.relpath(os.path.join(root, f), app)
        if os.path.normcase(os.path.normpath(rel)) not in names:
            stale.append(rel)
left = []
for rel in stale:
    try:
        os.remove(os.path.join(app, rel))
    except OSError:
        left.append(rel)
if stale:
    print('old files removed:', len(stale) - len(left))
if left:
    print('WARNING - files of an older version could not be removed; delete them by hand:\n  ' + '\n  '.join(left))
print(f'app version {version} - next: node patch-exe.mjs "{os.path.join(target, "PDF Editor.exe")}" app.ico')

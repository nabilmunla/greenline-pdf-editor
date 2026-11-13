# The Linux packages of a version (the public build): an AppImage (one file, runs anywhere, updates
# itself) and a .deb (Mint, Ubuntu, Debian - installed with the system's package installer).
#   python3 scripts/linux.py <outdir>      (publish.py runs it after pack.py: needs app-v<ver>.zip there)
# Writes <outdir>/<name>-<ver>-x86_64.AppImage, <outdir>/<name>_<ver>_amd64.deb and
# <outdir>/.linux.json (file, sha256, size of each - publish.py puts them in the signed latest.json).
# Downloads once, into ~/.cache/pdfed: Electron's Linux runtime (checked against Electron's
# published SHA-256 list) and the AppImage runtime (checked against the checksum below).
# Needs mksquashfs (squashfs-tools) and dpkg-deb.
import hashlib, json, os, shutil, stat, subprocess, sys, tempfile, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.abspath(sys.argv[1])
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
ver = pkg['version']
evr = json.load(open(os.path.join(ROOT, 'node_modules', 'electron', 'package.json')))['version']
NAME = pkg.get('displayName') or pkg.get('productName') or 'PDF Editor'
SLUG = ''.join(c if c.isalnum() else '-' for c in NAME.lower()).strip('-')   # greenline-pdf-editor
HOME = pkg.get('updateFeed') or ''
# (the AppImage runtime: AppImage/type2-runtime, the build from 2026-11 - a newer one is taken
# only after its checksum is written here)
RUNTIME_URL = 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64'
RUNTIME_SHA = '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46'
DESC = 'View, mark up, measure, edit and print PDF files'

for tool in ('mksquashfs', 'dpkg-deb'):
    if not shutil.which(tool):
        sys.exit(f'linux.py: {tool} is missing (apt install squashfs-tools dpkg)')

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

cache = os.path.expanduser('~/.cache/pdfed')
os.makedirs(cache, exist_ok=True)
ez = os.path.join(cache, f'electron-v{evr}-linux-x64.zip')
base = f'https://github.com/electron/electron/releases/download/v{evr}/'
sums = urllib.request.urlopen(base + 'SHASUMS256.txt').read().decode()
want = next(l.split()[0] for l in sums.splitlines() if l.strip().endswith(f'*electron-v{evr}-linux-x64.zip'))
if not os.path.exists(ez) or sha(ez) != want:
    print('downloading Electron', evr, '(Linux)')
    urllib.request.urlretrieve(base + f'electron-v{evr}-linux-x64.zip', ez)
assert sha(ez) == want, 'Electron download does not match its published checksum'
rt = os.path.join(cache, 'appimage', 'runtime-x86_64')
if not os.path.exists(rt) or sha(rt) != RUNTIME_SHA:
    os.makedirs(os.path.dirname(rt), exist_ok=True)
    urllib.request.urlretrieve(RUNTIME_URL, rt)
assert sha(rt) == RUNTIME_SHA, 'AppImage runtime does not match the checksum in linux.py (a newer one? check it, then write its checksum here)'

def unzip(zpath, dst, skip=lambda n: False):
    """with the files' own permissions (zipfile alone drops the 'runnable' bit)"""
    with zipfile.ZipFile(zpath) as z:
        for m in z.infolist():
            if skip(m.filename):
                continue
            p = os.path.join(dst, m.filename)
            if m.is_dir():
                os.makedirs(p, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(p), exist_ok=True)
            if (m.external_attr >> 16) & 0o170000 == 0o120000:   # a symlink
                os.symlink(z.read(m).decode(), p)
                continue
            with z.open(m) as s, open(p, 'wb') as d:
                shutil.copyfileobj(s, d)
            os.chmod(p, 0o755 if (m.external_attr >> 16) & 0o111 else 0o644)

work = tempfile.mkdtemp(prefix='pdfed-linux-')
try:
    # ---- the program folder (the same in both packages; install.json says which package it is)
    prog = os.path.join(work, 'prog')
    unzip(ez, prog, skip=lambda n: n.endswith('default_app.asar'))
    os.rename(os.path.join(prog, 'electron'), os.path.join(prog, SLUG))
    app = os.path.join(prog, 'resources', 'app')
    # (the Windows-only helper of Explorer's "Combine" isn't needed here)
    unzip(os.path.join(out, f'app-v{ver}.zip'), app, skip=lambda n: n.startswith('bin/'))
    for root, dirs, files in os.walk(app):
        for d in dirs: os.chmod(os.path.join(root, d), 0o755)
        for f in files: os.chmod(os.path.join(root, f), 0o644)
    apj = os.path.join(app, 'package.json')
    ap = json.load(open(apj))
    icon = os.path.join(app, 'dist', 'icon256.png')
    assert os.path.isfile(icon), 'dist/icon256.png missing'

    def desktop(exec_line, kind):
        return '\n'.join([
            '[Desktop Entry]', 'Type=Application', f'Name={NAME}', 'GenericName=PDF Editor', f'Comment={DESC}',
            f'Exec={exec_line} %F', f'Icon={SLUG}', 'Terminal=false', 'Categories=Office;Graphics;Viewer;',
            'MimeType=application/pdf;', f'StartupWMClass={SLUG}', 'StartupNotify=true',
            'Keywords=pdf;markup;measure;takeoff;print;ocr;', f'X-{kind}-Version={ver}', '']) + '\n'

    def program(dst, kind, desktop_id):
        shutil.copytree(prog, dst, symlinks=True)
        json.dump({'scope': 'user', 'version': ver, 'linux': kind}, open(os.path.join(dst, 'install.json'), 'w'))
        # (desktopName: the menu entry this copy belongs to - the window's icon and "Open with")
        json.dump({**ap, 'desktopName': desktop_id}, open(os.path.join(dst, 'resources', 'app', 'package.json'), 'w'), indent=2)

    # ---- AppImage: the AppImage runtime + a squashfs image of the AppDir
    appdir = os.path.join(work, 'AppDir')
    program(appdir, 'appimage', SLUG + '-appimage.desktop')
    open(os.path.join(appdir, 'AppRun'), 'w').write(f'''#!/bin/sh
# {NAME} - AppImage start
HERE="$(dirname "$(readlink -f "$0")")"
# Chromium's sandbox needs user namespaces; an AppImage can't carry its setuid helper. Where the
# system restricts them (Ubuntu 24.04 / Mint 22: AppArmor; older Debian: a sysctl), it runs
# without that sandbox - as every Electron AppImage does there.
nosb=
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && nosb=1
[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ] && nosb=1
[ -z "$nosb" ] && ! unshare -Ur true 2>/dev/null && nosb=1
if [ -n "$nosb" ]; then exec "$HERE/{SLUG}" --no-sandbox "$@"; fi
exec "$HERE/{SLUG}" "$@"
''')
    os.chmod(os.path.join(appdir, 'AppRun'), 0o755)
    open(os.path.join(appdir, SLUG + '.desktop'), 'w').write(desktop(SLUG, 'AppImage'))
    shutil.copy(icon, os.path.join(appdir, SLUG + '.png'))
    os.symlink(SLUG + '.png', os.path.join(appdir, '.DirIcon'))
    img = os.path.join(work, 'image.squashfs')
    subprocess.run(['mksquashfs', appdir, img, '-root-owned', '-noappend', '-comp', 'zstd', '-Xcompression-level', '19', '-b', '1M', '-quiet', '-no-progress'], check=True, stdout=subprocess.DEVNULL)
    ai_name = NAME.replace(' ', '-') + f'-{ver}-x86_64.AppImage'
    ai = os.path.join(out, ai_name)
    with open(ai, 'wb') as d:
        for p in (rt, img):
            with open(p, 'rb') as s:
                shutil.copyfileobj(s, d)
    os.chmod(ai, 0o755)

    # ---- .deb: /opt/<slug>, a menu entry, the icon, a command
    deb_root = os.path.join(work, 'deb')
    opt = os.path.join(deb_root, 'opt', SLUG)
    program(opt, 'deb', SLUG + '.desktop')
    apps = os.path.join(deb_root, 'usr', 'share', 'applications'); os.makedirs(apps)
    open(os.path.join(apps, SLUG + '.desktop'), 'w').write(desktop(f'/opt/{SLUG}/{SLUG}', 'Deb'))
    ic = os.path.join(deb_root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'); os.makedirs(ic)
    shutil.copy(icon, os.path.join(ic, SLUG + '.png'))
    bindir = os.path.join(deb_root, 'usr', 'bin'); os.makedirs(bindir)
    os.symlink(f'/opt/{SLUG}/{SLUG}', os.path.join(bindir, SLUG))
    doc = os.path.join(deb_root, 'usr', 'share', 'doc', SLUG); os.makedirs(doc)
    lic = os.path.join(ROOT, 'LICENSE')
    shutil.copy(lic if os.path.isfile(lic) else os.path.join(prog, 'LICENSE'), os.path.join(doc, 'copyright'))
    for root, dirs, files in os.walk(deb_root):
        for d in dirs: os.chmod(os.path.join(root, d), 0o755)
    size_kb = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(deb_root) for f in fs if not os.path.islink(os.path.join(r, f))) // 1024
    ctl = os.path.join(deb_root, 'DEBIAN'); os.makedirs(ctl)
    open(os.path.join(ctl, 'control'), 'w').write(f'''Package: {SLUG}
Version: {ver}
Section: graphics
Priority: optional
Architecture: amd64
Maintainer: {NAME} <nabilmunla@users.noreply.github.com>
Installed-Size: {size_kb}
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libnotify4, libxss1, libxtst6, xdg-utils, libatspi2.0-0t64 | libatspi2.0-0, libuuid1, libsecret-1-0, libgbm1, libasound2t64 | libasound2
Recommends: cups-client
Homepage: {HOME}
Description: {DESC}
 {NAME}: a PDF editor for drawings and documents - mark-up, measuring
 (lengths, areas, counts), editing text and pages, OCR, combining and
 printing. Works offline; updates itself from its download page.
''')
    # Chromium's sandbox: where unprivileged user namespaces are restricted (Ubuntu 24.04, Mint 22)
    # an AppArmor profile lets this program use them (AppArmor 4); the setuid helper is the fallback
    aa = f'/etc/apparmor.d/{SLUG}'
    open(os.path.join(ctl, 'postinst'), 'w').write(f'''#!/bin/sh
set -e
chmod 4755 '/opt/{SLUG}/chrome-sandbox' || true
if [ -d /etc/apparmor.d ] && [ -f /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
  cat > '{aa}' <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile {SLUG} /opt/{SLUG}/{SLUG} flags=(unconfined) {{
  userns,
  include if exists <local/{SLUG}>
}}
EOF
  apparmor_parser --replace --write-cache --skip-read-cache '{aa}' >/dev/null 2>&1 || true
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
''')
    open(os.path.join(ctl, 'postrm'), 'w').write(f'''#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  if [ -f '{aa}' ]; then
    command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R '{aa}' >/dev/null 2>&1 || true
    rm -f '{aa}'
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
fi
exit 0
''')
    for f in ('postinst', 'postrm'):
        os.chmod(os.path.join(ctl, f), 0o755)
    deb_name = f'{SLUG}_{ver}_amd64.deb'
    deb = os.path.join(out, deb_name)
    subprocess.run(['dpkg-deb', '--root-owner-group', '-Zxz', '--build', deb_root, deb], check=True, stdout=subprocess.DEVNULL)

    entries = {k: {'file': os.path.basename(p), 'sha256': sha(p), 'size': os.path.getsize(p)} for k, p in (('appimage', ai), ('deb', deb))}
    json.dump(entries, open(os.path.join(out, '.linux.json'), 'w'), indent=2)
    for k, e in entries.items():
        print(f"linux {k}: {e['file']} ({e['size'] / 1e6:.0f} MB)")
finally:
    shutil.rmtree(work, ignore_errors=True)

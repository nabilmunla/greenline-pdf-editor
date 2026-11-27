# Nothing shipped may hold the build machine's paths: its home folder names the account (debug
# info in native libraries can carry hundreds of them). Run at the end of a publish:
#   python3 scripts/buildpaths.py [--needle <text>]... <file>...
# Needles default to this machine's home folder and the source folder. A zip is read entry by entry
# here (a zip that can't be read whole fails: an unzip that skipped entries passed files it never
# looked at); any other file is searched as it is, for the text and for its UTF-16 form (Windows).
import os, sys, zipfile

def needles_of(argv):
    out, files, i = [], [], 0
    while i < len(argv):
        if argv[i] == '--needle': out.append(argv[i + 1]); i += 2
        else: files.append(argv[i]); i += 1
    if not out:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        # (with the separator after: '/root' alone is also a fallback in the code, not a path of this machine)
        out = [p.rstrip('/\\') + os.sep for p in {os.path.expanduser('~'), root} if p and len(p) > 4]
    pats = []
    for n in out:
        for v in {n, n.replace('/', '\\')}:
            pats += [v.encode('utf-8'), v.encode('utf-16le')]
    return pats, files

def hits(data, pats):
    return any(p in data for p in pats)

def scan(path, pats, bad):
    if path.lower().endswith('.zip') and not zipfile.is_zipfile(path):
        raise ValueError('not a readable zip')
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir(): continue
                data = z.read(info)   # (raises on an entry it can't read: the scan fails)
                if hits(data, pats): bad.append(f'{path}!{info.filename}')
                elif info.filename.lower().endswith('.zip'):
                    import io
                    with zipfile.ZipFile(io.BytesIO(data)) as inner:
                        for j in inner.infolist():
                            if not j.is_dir() and hits(inner.read(j), pats): bad.append(f'{path}!{info.filename}!{j.filename}')
        return
    with open(path, 'rb') as f:
        if hits(f.read(), pats): bad.append(path)

def main(argv):
    pats, files = needles_of(argv)
    bad, failed = [], []
    for p in files:
        try: scan(p, pats, bad)
        except Exception as e: failed.append(f'{p}: {e}')
    for b in bad: print('build path in', b)
    for f in failed: print('could not read', f)
    if bad or failed: return 1
    print(f'no build paths in {len(files)} file(s)')
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

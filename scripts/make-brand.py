# A build's look from one folder of logo sources: python3 scripts/make-brand.py <brand folder> [<tree>]
#   <brand>/mark.svg        the logo (title bar, setup window; drawn at 32 px and up)
#   <brand>/mark-small.svg  the same, simplified for 16-24 px (optional)
# Writes into <tree> (default: here): public/gmark.svg, public/icon256.png, pack/app.ico, then the
# PDF file icon (scripts/make-file-icon.py: the page with its PDF label and this logo as a badge).
# Needs rsvg-convert (librsvg) and Pillow.
import os, subprocess, sys, shutil, tempfile
from PIL import Image

brand = os.path.abspath(sys.argv[1])
tree = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else '.')
big = os.path.join(brand, 'mark.svg')
small = os.path.join(brand, 'mark-small.svg')
if not os.path.exists(small):
    small = big
tmp = tempfile.mkdtemp()

def png(svg, size):
    out = os.path.join(tmp, f'{size}.png')
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), svg, '-o', out], check=True)
    return Image.open(out).convert('RGBA')

shutil.copyfile(big, os.path.join(tree, 'public', 'gmark.svg'))
png(big, 256).save(os.path.join(tree, 'public', 'icon256.png'))
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
imgs = [png(small if s <= 24 else big, s) for s in sizes]
# (each size drawn on its own - a 256 px picture scaled down by Windows blurs at 16 px)
imgs[-1].save(os.path.join(tree, 'pack', 'app.ico'), format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
subprocess.run([sys.executable, os.path.join(tree, 'scripts', 'make-file-icon.py')], cwd=tree, check=True, stdout=subprocess.DEVNULL)
shutil.rmtree(tmp, ignore_errors=True)
print('brand applied from', brand)

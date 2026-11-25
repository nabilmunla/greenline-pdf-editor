"""START HERE.txt of the testers' copy (publish.py): installer/ALPHA-TEST.txt with the lines of
this edition kept - <<company>> ... <</company>> or <<greenline>> ... <</greenline>> - and the
version filled in. The company copy keeps everything on the PC; the Greenline build does not
(update checks, the anonymous count, the reports the person sends): it said it did (F39)."""
import re


def start_here(text, brand, ver):
    keep = 'greenline' if brand == 'greenline' else 'company'
    for ed in ('company', 'greenline'):
        pat = re.compile(r'<<%s>>\n(.*?)<</%s>>\n' % (ed, ed), re.S)
        text = pat.sub((lambda m: m.group(1)) if ed == keep else '', text)
    return text.replace('{{VERSION}}', ver)

# Validate every XML part of an .xlsx against the ECMA SpreadsheetML schemas (+ OPC parts)
import sys, zipfile, re
from lxml import etree
S = '/mnt/skills/public/docx/scripts/office/schemas/'
import glob
def load(p):
    return etree.XMLSchema(etree.parse(p))
schemas = {}
def schema_for(name):
    if name.startswith('xl/worksheets/') or name in ('xl/workbook.xml','xl/styles.xml','xl/sharedStrings.xml'):
        return S + 'ISO-IEC29500-4_2016/sml.xsd'
    if name == '[Content_Types].xml': return S + 'ecma/fouth-edition/opc-contentTypes.xsd'
    if name.endswith('.rels'): return S + 'ecma/fouth-edition/opc-relationships.xsd'
    if name == 'docProps/core.xml': return S + 'ecma/fouth-edition/opc-coreProperties.xsd'
    if name == 'docProps/app.xml': return S + 'ISO-IEC29500-4_2016/shared-documentPropertiesExtended.xsd'
    return None
bad = 0
for f in sys.argv[1:]:
    z = zipfile.ZipFile(f)
    errs = []
    for n in z.namelist():
        if not (n.endswith('.xml') or n.endswith('.rels')): continue
        sp = schema_for(n)
        try:
            doc = etree.fromstring(z.read(n))
        except Exception as e:
            errs.append(f'{n}: not well-formed: {e}'); continue
        if not sp or n == 'docProps/core.xml': continue
        # Excel writes xml:space on <t> itself; the bare ISO schema doesn't declare it
        for el in doc.iter():
            el.attrib.pop('{http://www.w3.org/XML/1998/namespace}space', None)
        try:
            if sp not in schemas: schemas[sp] = load(sp)
        except Exception as e:
            errs.append(f'{n}: schema load {sp}: {e}'); continue
        if not schemas[sp].validate(doc):
            for e in list(schemas[sp].error_log)[:5]: errs.append(f'{n}:{e.line}: {e.message}')
    print(('OK   ' if not errs else 'BAD  ') + f)
    for e in errs[:12]: print('     ' + e)
    bad += bool(errs)
sys.exit(1 if bad else 0)

import * as mupdf from 'mupdf'; import {readFileSync} from 'fs';
const d = mupdf.Document.openDocument(readFileSync(process.argv[2]),'application/pdf'); console.log(JSON.stringify(d.loadPage(0).toStructuredText('').asText().slice(0,80)));

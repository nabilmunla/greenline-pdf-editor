// Command-line converter for tests: node tests/export/convert.mjs in.pdf out.(xlsx|docx) [--pages-sheets] [--no-ocr]
// Runs the app's export code (src/engine/convert) under tsx; scanned pages are read with Tesseract here.
import { register } from 'tsx/esm/api';
register();
await import('./convert-run.ts');

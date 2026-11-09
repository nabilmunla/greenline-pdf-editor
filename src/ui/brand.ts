// The build's name and look. The company build: "PDF Editor" in the company colours. The public
// build (package.json "displayName" / "brand", set by scripts/export-public.py): "Greenline PDF
// Editor", green. Only what people see changes - files, folders and settings keep their names.
declare const __APP_NAME__: string;
declare const __BRAND__: string;

export const APP_NAME: string = typeof __APP_NAME__ === 'string' ? __APP_NAME__ : 'PDF Editor';
export const BRAND: string = typeof __BRAND__ === 'string' ? __BRAND__ : '';
// the wordmark: the first word stands out ("PDF Editor", "Greenline PDF Editor")
const sp = APP_NAME.indexOf(' ');
export const WORD_LEAD = sp > 0 ? APP_NAME.slice(0, sp) : APP_NAME;
export const WORD_REST = sp > 0 ? APP_NAME.slice(sp) : '';
if (BRAND && typeof document !== 'undefined') document.documentElement.dataset.brand = BRAND;

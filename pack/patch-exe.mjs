// Set the icon and version details of the app's .exe (run on the PC: node patch-exe.mjs <exe> <ico> [version])
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [exePath, icoPath, versionArg] = process.argv.slice(2);
// (no version given: the app's own, from its package.json next to the exe - so the exe says the
// version it runs; a hand-made copy once said 0.1.0 running 0.5.0)
const version = versionArg || JSON.parse(readFileSync(join(dirname(exePath), 'resources', 'app', 'package.json'), 'utf8')).version;
const exe = PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
const [a, b, c] = version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'PDF Editor', ProductName: 'PDF Editor', InternalName: 'PDF Editor', OriginalFilename: 'PDF Editor.exe',
  CompanyName: '', LegalCopyright: '', FileVersion: version, ProductVersion: version,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('patched', exePath, version);

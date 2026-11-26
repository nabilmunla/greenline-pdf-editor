//go:build !windows

package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// fakeSetup writes an "exe" with a payload holding files (path -> content).
func fakeSetup(t *testing.T, dir, ver string, files map[string]string) string {
	t.Helper()
	var tb bytes.Buffer
	tw := tar.NewWriter(&tb)
	var total int64
	for name, body := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
		total += int64(len(body))
	}
	tw.Close()
	var zb bytes.Buffer
	zw, _ := zstd.NewWriter(&zb)
	_, _ = zw.Write(tb.Bytes())
	zw.Close()
	meta, _ := json.Marshal(Meta{Version: ver, Runtime: "44.5.1", Total: total, Files: len(files)})
	exe := []byte("MZ-this-is-the-program-part")
	var out bytes.Buffer
	out.Write(exe)
	out.Write(zb.Bytes())
	out.Write(meta)
	n := make([]byte, 8)
	binary.LittleEndian.PutUint64(n, uint64(len(meta)))
	out.Write(n)
	binary.LittleEndian.PutUint64(n, uint64(zb.Len()))
	out.Write(n)
	out.WriteString(magic)
	p := filepath.Join(dir, "setup-"+ver+".exe")
	if err := os.WriteFile(p, out.Bytes(), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func appFiles(ver string) map[string]string {
	return map[string]string{
		exeName:                         "electron",
		"resources/app/package.json":    `{"version":"` + ver + `"}`,
		"resources/app/dist/index.html": "<html>" + ver,
		"locales/en-US.pak":             "pak",
	}
}

func appZip(t *testing.T, dir, ver string, wrongVersion bool) string {
	t.Helper()
	p := filepath.Join(dir, "app-v"+ver+".zip")
	f, _ := os.Create(p)
	zw := zip.NewWriter(f)
	v := ver
	if wrongVersion {
		v = "9.9.9"
	}
	for name, body := range map[string]string{"package.json": `{"version":"` + v + `"}`, "dist/index.html": "<html>" + ver, "electron/main.cjs": "main " + ver} {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(body))
	}
	zw.Close()
	f.Close()
	return p
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func setupTest(t *testing.T) string {
	root := t.TempDir()
	testRoot = root
	logPath = filepath.Join(root, "setup.log")
	return root
}

func TestPayloadInstallUpdateUninstall(t *testing.T) {
	root := setupTest(t)
	s1 := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	p, err := openPayload(s1)
	if err != nil || !p.present || p.Meta.Version != "0.4.0" {
		t.Fatalf("payload: %v %+v", err, p)
	}
	dir := filepath.Join(root, "Programs", appName)
	var last float64
	err = doInstall(p, Options{Scope: "user", Dir: dir, Desktop: true, OpenWith: true, Source: `\\srv\apps\PDF Editor`}, func(pct float64, _ string) { last = pct })
	if err != nil {
		t.Fatal(err)
	}
	if last != 1 {
		t.Errorf("progress ended at %v", last)
	}
	if read(t, filepath.Join(dir, "resources/app/dist/index.html")) != "<html>0.4.0" {
		t.Error("files not extracted")
	}
	// the helper is the program part only
	if read(t, filepath.Join(dir, setupName)) != "MZ-this-is-the-program-part" {
		t.Error("helper copy should be the exe part without the payload")
	}
	hp, _ := openPayload(filepath.Join(dir, setupName))
	if hp.present {
		t.Error("helper must not have a payload")
	}
	var uc UpdateConf
	if readJSON(filepath.Join(dir, "update.json"), &uc); uc.Source != `\\srv\apps\PDF Editor` {
		t.Errorf("update.json: %+v", uc)
	}
	ii, _ := readInstall(dir)
	if ii == nil || ii.Version != "0.4.0" || ii.Scope != "user" || !ii.Desktop {
		t.Errorf("install.json: %+v", ii)
	}

	// app update 0.4.1: zip applied, old kept, version recorded
	z := appZip(t, root, "0.4.1", false)
	sha, _ := fileSHA256(z)
	if err := applyApp(dir, z, sha, "0.4.1"); err != nil {
		t.Fatal(err)
	}
	if appVersionAt(dir, "app") != "0.4.1" || appVersionAt(dir, "app.old") != "0.4.0" {
		t.Errorf("after update: app=%s old=%s", appVersionAt(dir, "app"), appVersionAt(dir, "app.old"))
	}
	if ii, _ := readInstall(dir); ii.Version != "0.4.1" {
		t.Errorf("install.json version %s", ii.Version)
	}
	// a damaged package changes nothing
	bad := appZip(t, root, "0.4.2", false)
	if err := applyApp(dir, bad, strings.Repeat("0", 64), "0.4.2"); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Errorf("bad checksum should fail: %v", err)
	}
	// a package holding another version changes nothing (a copy left by an update cut short is
	// no reason to fail: it is the version check that refuses this one)
	_ = os.WriteFile(filepath.Join(dir, "resources", "app.pkg"), []byte("left over"), 0o644)
	wrong := appZip(t, root, "0.4.3", true)
	wsha, _ := fileSHA256(wrong)
	if err := applyApp(dir, wrong, wsha, "0.4.3"); err == nil || !strings.Contains(err.Error(), "holds version") {
		t.Errorf("wrong version inside should fail on the version: %v", err)
	}
	if appVersionAt(dir, "app") != "0.4.1" || fileExists(filepath.Join(dir, "resources", "app.new")) {
		t.Error("failed updates must leave the app as it was")
	}
	// the package is checked and unpacked from a copy in the install folder, which never stays
	if fileExists(filepath.Join(dir, "resources", "app.pkg")) {
		t.Error("the copy of the package (resources\\app.pkg) must not stay")
	}
	// back to 0.4.0, then forward again
	if err := rollbackApp(dir); err != nil {
		t.Fatal(err)
	}
	if appVersionAt(dir, "app") != "0.4.0" || appVersionAt(dir, "app.old") != "0.4.1" {
		t.Errorf("rollback: app=%s old=%s", appVersionAt(dir, "app"), appVersionAt(dir, "app.old"))
	}
	if err := rollbackApp(dir); err != nil || appVersionAt(dir, "app") != "0.4.1" {
		t.Errorf("roll forward: %v %s", err, appVersionAt(dir, "app"))
	}

	// full setup 0.5.0 over it: old folder replaced, nothing left over
	s2 := fakeSetup(t, root, "0.5.0", map[string]string{exeName: "electron2", "resources/app/package.json": `{"version":"0.5.0"}`})
	p2, _ := openPayload(s2)
	if err := doInstall(p2, Options{Scope: "user", Dir: dir, Source: ""}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(dir, "locales/en-US.pak")) || fileExists(dir+".old") || fileExists(dir+".new") {
		t.Error("old files / temp folders left behind")
	}
	if fileExists(filepath.Join(dir, "update.json")) {
		t.Error("cleared updates folder should remove update.json")
	}

	// uninstall removes the folder
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(dir) {
		t.Error("folder still there")
	}
}

func TestNeverDeletesOtherFolders(t *testing.T) {
	root := setupTest(t)
	docs := filepath.Join(root, "Documents")
	os.MkdirAll(docs, 0o755)
	os.WriteFile(filepath.Join(docs, "tender.xlsx"), []byte("x"), 0o644)
	if err := doUninstall(docs, func(float64, string) {}); err == nil {
		t.Error("uninstall must refuse a folder that isn't an install")
	}
	s := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	p, _ := openPayload(s)
	if err := doInstall(p, Options{Scope: "user", Dir: docs}, func(float64, string) {}); err == nil {
		t.Error("install must refuse a folder with other files")
	}
	if read(t, filepath.Join(docs, "tender.xlsx")) != "x" {
		t.Error("the person's file was touched")
	}
	if msg := checkDir("user", docs); msg == "" {
		t.Error("checkDir should warn about a folder with other files")
	}
	if msg := checkDir("user", "relative\\path"); msg == "" {
		t.Error("checkDir should want a full path")
	}
	if looksInstalled(filepath.VolumeName(root) + string(os.PathSeparator)) {
		t.Error("a drive root is never an install")
	}
}

func TestSafeRelAndVersions(t *testing.T) {
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "C:/Windows/x"} {
		if _, err := safeRel(bad); err == nil {
			t.Errorf("%s should be refused", bad)
		}
	}
	if r, _ := safeRel("./resources/app/x.js"); r != filepath.FromSlash("resources/app/x.js") {
		t.Errorf("got %s", r)
	}
	cases := [][2]string{{"0.3.9", "0.3.10"}, {"0.4.0", "0.4.1"}, {"0.9", "1.0.0"}, {"1.2.3", "1.10.0"}}
	for _, c := range cases {
		if !versionLess(c[0], c[1]) || versionLess(c[1], c[0]) {
			t.Errorf("%s < %s", c[0], c[1])
		}
	}
	if versionLess("0.4.0", "0.4.0") {
		t.Error("equal is not less")
	}
}

func TestDamagedSetup(t *testing.T) {
	root := setupTest(t)
	s := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	b, _ := os.ReadFile(s)
	// cut a chunk out of the middle of the payload
	cut := append(append([]byte{}, b[:40]...), b[60:]...)
	os.WriteFile(s, cut, 0o755)
	p, err := openPayload(s)
	if err == nil && p.present {
		if err := p.Extract(filepath.Join(root, "x"), nil); err == nil {
			t.Error("a damaged payload should fail to extract")
		}
	}
	dir := filepath.Join(root, "Programs", appName)
	if err == nil && p.present {
		if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err == nil {
			t.Error("install from a damaged setup should fail")
		}
		if fileExists(dir) || fileExists(dir+".new") {
			t.Error("a failed install must leave nothing behind")
		}
	}
}

func TestReplaceKeepsOldOnFailure(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "app")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "a"), []byte("old"), 0o644)
	err := replaceDir(dir, func(tmp string) error { os.MkdirAll(tmp, 0o755); return os.ErrInvalid }, nil)
	if err == nil || read(t, filepath.Join(dir, "a")) != "old" || fileExists(dir+".new") {
		t.Error("a failed fill must keep the old folder")
	}
	err = replaceDir(dir, func(tmp string) error {
		os.MkdirAll(tmp, 0o755)
		return os.WriteFile(filepath.Join(tmp, "b"), []byte("new"), 0o644)
	}, []string{"a"})
	if err != nil || read(t, filepath.Join(dir, "b")) != "new" || read(t, filepath.Join(dir, "a")) != "old" {
		t.Errorf("replace with keep: %v", err)
	}
}

// a minimal PE header: e_lfanew at 0x3c -> "PE\0\0", COFF header, PE32+ optional header with the
// certificate table entry (data directory 4)
func peHeader() ([]byte, int) {
	h := make([]byte, 0x200)
	h[0], h[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(h[0x3c:], 0x80)
	copy(h[0x80:], "PE\x00\x00")
	opt := 0x80 + 4 + 20
	binary.LittleEndian.PutUint16(h[opt:], 0x20b)
	return h, opt + 112 + 4*8
}

func TestSignedSetupStillFindsItsPayload(t *testing.T) {
	root := setupTest(t)
	plain := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	body, _ := os.ReadFile(plain)
	hdr, at := peHeader()
	exe := append(append([]byte{}, hdr...), body...)
	// signing: padded to 8 bytes, the certificate table appended, the header pointing at it
	for len(exe)%8 != 0 {
		exe = append(exe, 0)
	}
	cert := bytes.Repeat([]byte{0xA5}, 1500)
	binary.LittleEndian.PutUint32(exe[at:], uint32(len(exe)))
	binary.LittleEndian.PutUint32(exe[at+4:], uint32(len(cert)))
	exe = append(exe, cert...)
	signed := filepath.Join(root, "signed.exe")
	os.WriteFile(signed, exe, 0o755)
	p, err := openPayload(signed)
	if err != nil || !p.present || p.Meta.Version != "1.0.0" {
		t.Fatalf("signed setup: payload not found (%v, %+v)", err, p)
	}
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "resources", "app", "package.json")) == "" {
		t.Error("not installed from the signed setup")
	}
	// the helper copy: exe part only, its certificate entry cleared, no payload
	h, _ := os.ReadFile(filepath.Join(dir, setupName))
	if binary.LittleEndian.Uint64(h[at:]) != 0 {
		t.Error("the helper copy still points at a signature it doesn't have")
	}
	if q, _ := openPayload(filepath.Join(dir, setupName)); q == nil || q.present {
		t.Error("the helper copy must have no payload")
	}
}

func TestSwapLeavesNeighboursAlone(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "Work")
	for _, n := range []string{"Work.old", "Work.new"} {
		os.MkdirAll(filepath.Join(root, n), 0o755)
		os.WriteFile(filepath.Join(root, n, "mine.txt"), []byte("keep"), 0o644)
	}
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"Work.old", "Work.new"} {
		if read(t, filepath.Join(root, n, "mine.txt")) != "keep" {
			t.Errorf("%s was touched", n)
		}
	}
	if left, _ := filepath.Glob(dir + ".pdfed-*"); len(left) > 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestInstallFilesAreInBeforeTheSwap(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	// the swap is the last step: watch what the new folder holds at that moment
	var seen []string
	if err := doInstall(p, Options{Scope: "user", Dir: dir, Source: `\\server\share`}, func(pct float64, stage string) {
		if pct >= 0.92 && seen == nil {
			for _, f := range []string{"install.json", "update.json", setupName} {
				if fileExists(filepath.Join(dir, f)) {
					seen = append(seen, f)
				}
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 {
		t.Errorf("when the folder appeared it held only %v", seen)
	}
}

func TestOlderHandMadeCopyIsReplaced(t *testing.T) {
	root := setupTest(t)
	old := filepath.Join(root, "Program Files", "PDF Editor")
	os.MkdirAll(filepath.Join(old, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(old, exeName), []byte("old electron"), 0o755)
	os.WriteFile(filepath.Join(old, "resources", "app", "package.json"), []byte(`{"name":"pdf-editor","productName":"PDF Editor","version":"0.2.6","main":"electron/main.cjs"}`), 0o644)
	if v := olderCopy(old); v != "0.2.6" {
		t.Fatalf("older copy not recognised: %q", v)
	}
	if msg := checkDir("user", old); msg != "" {
		t.Fatalf("checkDir refused the older copy: %s", msg)
	}
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	if err := doInstall(p, Options{Scope: "user", Dir: old}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if !looksInstalled(old) || read(t, filepath.Join(old, "resources", "app", "dist", "index.html")) != "<html>1.0.0" {
		t.Error("the older copy was not replaced by the new version")
	}
	// anything that only looks a bit like it is still refused
	other := filepath.Join(root, "Tools")
	os.MkdirAll(filepath.Join(other, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(other, exeName), []byte("x"), 0o755)
	os.WriteFile(filepath.Join(other, "resources", "app", "package.json"), []byte(`{"productName":"Something else","main":"main.js"}`), 0o644)
	if olderCopy(other) != "" || checkDir("user", other) == "" {
		t.Error("a different program's folder must not count as an older copy")
	}
	if err := doInstall(p, Options{Scope: "user", Dir: other}, func(float64, string) {}); err == nil {
		t.Error("installing over a different program's folder must be refused")
	}
}

// A reinstall without --updates (setup run by hand from Downloads) keeps the updates folder;
// --apply without --version still records the version; an admin-rights job only touches installs.
func TestReinstallKeepsSourceApplyRecordsVersionJobsOnlyOnInstalls(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.4.0", appFiles("0.4.0")))
	dir := filepath.Join(root, "Programs", appName)
	src := `\\srv\apps\PDF Editor`
	if err := doInstall(p, Options{Scope: "user", Dir: dir, Source: src}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if keptSource(dir) != src || keptSource(filepath.Join(root, "elsewhere")) != "" {
		t.Fatalf("keptSource: %q", keptSource(dir))
	}
	p2, _ := openPayload(fakeSetup(t, root, "0.5.0", appFiles("0.5.0")))
	if err := doInstall(p2, Options{Scope: "user", Dir: dir, Source: keptSource(dir)}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	var uc UpdateConf
	if readJSON(filepath.Join(dir, "update.json"), &uc); uc.Source != src {
		t.Errorf("reinstall lost the updates folder: %+v", uc)
	}
	// --apply ZIP --sha256 H, no --version
	z := appZip(t, root, "0.5.1", false)
	sha, _ := fileSHA256(z)
	if err := applyApp(dir, z, sha, ""); err != nil {
		t.Fatal(err)
	}
	if ii, _ := readInstall(dir); ii == nil || ii.Version != "0.5.1" {
		t.Errorf("install.json after --apply without --version: %+v", ii)
	}
	// a job naming a folder that isn't an install changes nothing there
	other := filepath.Join(root, "Data")
	os.MkdirAll(filepath.Join(other, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(other, "resources", "app", "keep.txt"), []byte("mine"), 0o644)
	z2 := appZip(t, root, "0.5.2", false)
	sha2, _ := fileSHA256(z2)
	for _, j := range []Job{{Kind: "apply", Dir: other, Zip: z2, Sha: sha2, Version: "0.5.2"}, {Kind: "rollback", Dir: other}} {
		if err := runJob(nil, j, func(float64, string) {}); err == nil || !strings.Contains(err.Error(), "doesn't look like") {
			t.Errorf("%s on a folder that isn't an install: %v", j.Kind, err)
		}
	}
	if read(t, filepath.Join(other, "resources", "app", "keep.txt")) != "mine" || fileExists(filepath.Join(other, "resources", "app.old")) {
		t.Error("a folder that isn't an install was changed")
	}
	if err := runJob(nil, Job{Kind: "apply", Dir: dir, Zip: z2, Sha: sha2, Version: "0.5.2"}, func(float64, string) {}); err != nil || appVersionAt(dir, "app") != "0.5.2" {
		t.Errorf("apply job on the install: %v %s", err, appVersionAt(dir, "app"))
	}
}

// ---- PLAN 11.2: the Greenline setup over a company copy

func greenlineFiles(ver string) map[string]string {
	f := appFiles(ver)
	f["resources/app/package.json"] = `{"version":"` + ver + `","brand":"greenline","displayName":"Greenline PDF Editor"}`
	return f
}

// asGreenline: this test binary is "the Greenline setup" (build.py sets both with -X)
func asGreenline(t *testing.T, feed string) {
	t.Helper()
	d, s := displayName, defaultSource
	displayName, defaultSource = "Greenline PDF Editor", feed
	t.Cleanup(func() { displayName, defaultSource = d, s })
}

func updateJSON(t *testing.T, dir string) (UpdateConf, bool) {
	t.Helper()
	var uc UpdateConf
	if !fileExists(filepath.Join(dir, "update.json")) {
		return uc, false
	}
	if err := readJSON(filepath.Join(dir, "update.json"), &uc); err != nil {
		t.Fatal(err)
	}
	return uc, true
}

// installCompany: a company copy (no brand) installed from the share, by the company's own setup
func installCompany(t *testing.T, root, share string) string {
	t.Helper()
	_ = os.MkdirAll(root, 0o755)
	p, _ := openPayload(fakeSetup(t, root, "0.12.1", appFiles("0.12.1")))
	dir := defaultDir("user")
	if err := doInstall(p, Options{Scope: "user", Dir: dir, Desktop: true, OpenWith: true, Source: share}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	return dir
}

const feedURL = "https://github.com/example/greenline-pdf-editor"

func TestGreenlineSetupOverCompanyCopyWritesItsOwnAddress(t *testing.T) {
	root := setupTest(t)
	share := `\\srv\apps\PDF Editor`
	dir := installCompany(t, root, share)
	asGreenline(t, feedURL)
	// silent, no --updates: not the share kept for good
	if got := sourceWhenNoneGiven(dir); got != feedURL {
		t.Fatalf("silent setup over a company copy keeps %q, want the feed", got)
	}
	if kept, said := keptSourceOf(dir); kept != feedURL || !said {
		t.Fatalf("keptSourceOf: %q %v", kept, said)
	}
	p, _ := openPayload(fakeSetup(t, root, "0.13.0", greenlineFiles("0.13.0")))
	ii0, _ := readInstall(dir)
	if err := doInstall(p, Options{Scope: ii0.Scope, Dir: dir, Desktop: ii0.Desktop, OpenWith: ii0.OpenWith, Source: sourceWhenNoneGiven(dir)}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if uc, ok := updateJSON(t, dir); !ok || uc.Source != feedURL {
		t.Errorf("update.json after the Greenline setup: %+v", uc)
	}
	// scope, desktop shortcut and "open PDFs with" are the copy's own, as before
	if ii, _ := readInstall(dir); ii == nil || ii.Version != "0.13.0" || ii.Scope != "user" || !ii.Desktop || !ii.OpenWith {
		t.Errorf("install.json: %+v", ii)
	}
	// (the wizard's offer over an install, installState, takes the same sourceWhenNoneGiven; findInstalled is Windows-only)
	// and now it is a Greenline copy on the web: a second setup keeps it
	if sourceWhenNoneGiven(dir) != feedURL {
		t.Errorf("second setup: %q", sourceWhenNoneGiven(dir))
	}
}

func TestGreenlineSetupUpdateOverCompanyCopyAtARuntimeChange(t *testing.T) {
	root := setupTest(t)
	dir := installCompany(t, root, `\\srv\apps\PDF Editor`)
	asGreenline(t, feedURL)
	p, _ := openPayload(fakeSetup(t, root, "0.14.0", greenlineFiles("0.14.0")))
	if code := cmdUpdate(p, dir, 0, false); code != 0 {
		t.Fatalf("cmdUpdate: %d", code)
	}
	if uc, _ := updateJSON(t, dir); uc.Source != feedURL {
		t.Errorf("update.json after cmdUpdate: %+v", uc)
	}
	if appVersionAt(dir, "app") != "0.14.0" {
		t.Errorf("version %s", appVersionAt(dir, "app"))
	}
}

func TestGreenlineSetupKeepsWhatIsNotTheCompanysShare(t *testing.T) {
	root := setupTest(t)
	// a Greenline copy on a folder of its own choice keeps its folder
	p, _ := openPayload(fakeSetup(t, root, "0.13.0", greenlineFiles("0.13.0")))
	dir := filepath.Join(root, "Programs", appName)
	own := `D:\my updates`
	if err := doInstall(p, Options{Scope: "user", Dir: dir, Source: own}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	asGreenline(t, feedURL)
	if got := sourceWhenNoneGiven(dir); got != own {
		t.Errorf("a Greenline copy on a folder: %q", got)
	}
	// a company copy with "no updates" chosen (empty), or already on a web address: left as it is
	for _, src := range []string{"", "https://example.org/releases"} {
		d := filepath.Join(root, "Other "+strings.ReplaceAll(src, "/", "_"))
		p2, _ := openPayload(fakeSetup(t, root, "0.12.1", appFiles("0.12.1")))
		displayName, defaultSource = appName, "" // (installed by the company's setup)
		if err := doInstall(p2, Options{Scope: "user", Dir: d, Source: src}, func(float64, string) {}); err != nil {
			t.Fatal(err)
		}
		displayName, defaultSource = "Greenline PDF Editor", feedURL
		if src == "" {
			// (no address of its own is written when none was given: the company setup's update.json is empty only if it said so)
			_ = os.WriteFile(filepath.Join(d, "update.json"), []byte(`{"source":""}`), 0o644)
		}
		if got := sourceWhenNoneGiven(d); got != src {
			t.Errorf("company copy with source %q: got %q", src, got)
		}
	}
	// a copy whose package.json can't be read is not taken for the company's
	d2 := installCompany(t, filepath.Join(root, "x"), `\\srv\apps\PDF Editor`) // (own setup folder; same default dir, own test root)
	_ = os.Remove(filepath.Join(d2, "resources", "app", "package.json"))
	if got := sourceWhenNoneGiven(d2); got != `\\srv\apps\PDF Editor` {
		t.Errorf("unreadable package.json: %q", got)
	}
}

func TestCompanyBuiltSetupKeepsTheFolderAsToday(t *testing.T) {
	root := setupTest(t)
	share := `\\srv\apps\PDF Editor`
	dir := installCompany(t, root, share)
	if defaultSource != "" {
		t.Fatal("this test is the company-built setup")
	}
	if got := sourceWhenNoneGiven(dir); got != share {
		t.Errorf("company setup over a company copy: %q", got)
	}
	if keptSource(dir) != share {
		t.Errorf("keptSource: %q", keptSource(dir))
	}
}

// What must stay equal between the editions, so that a Greenline copy IS the company copy to Windows: the
// names and keys that decide where files, shortcuts, the Programs entry, "open with" and the settings are.
// Read from the sources against a fixed list (passes on 0.12.1: a guard against a change, not a fix).
func TestEditionsShareTheNamesWindowsKnows(t *testing.T) {
	src := func(rel string) string {
		b, err := os.ReadFile(rel)
		if err != nil {
			t.Skipf("%s is not in this checkout (%v)", rel, err)
		}
		return string(b)
	}
	has := func(text, re, file string) {
		t.Helper()
		if !regexp.MustCompile(re).MatchString(text) {
			t.Errorf("%s: expected %s", file, re)
		}
	}
	core := src("core.go")
	has(core, `(?m)^\s*appName\s*=\s*"PDF Editor"\s*$`, "core.go appName")
	has(core, `(?m)^\s*exeName\s*=\s*"PDF Editor\.exe"\s*$`, "core.go exeName")
	has(core, `(?m)^\s*setupName\s*=\s*"PDF Editor Setup\.exe"\s*$`, "core.go setupName")
	win := src("win_windows.go")
	has(win, "(?m)^\\s*uninstallKey\\s*=\\s*`Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\PDFEditor`", "win_windows.go uninstallKey")
	has(win, `(?m)^\s*progID\s*=\s*"PDFEditor\.Document"`, "win_windows.go progID")
	has(win, "(?m)^\\s*capsKey\\s*=\\s*`Software\\\\PDF Editor\\\\Capabilities`", "win_windows.go capsKey")
	has(win, "(?m)^\\s*combineKey\\s*=\\s*`\\\\SystemFileAssociations\\\\\\.pdf\\\\shell\\\\PDFEditor\\.Combine`", "win_windows.go combineKey")
	has(win, `(?m)^const aumid = "pdfeditor\.app"`, "win_windows.go aumid")
	// 14.12: "Combine PDFs in this folder" on a folder's right-click - the setup's entry and the app's
	// per-user copy use the same key; it is added with the file entry and removed with it
	has(win, "(?m)^\\s*combineFolderKey\\s*=\\s*`\\\\Directory\\\\shell\\\\PDFEditor\\.CombineFolder`", "win_windows.go combineFolderKey")
	has(win, `add\(setStr\(root, classes\+combineFolderKey\+`+"`\\\\command`"+`, "", `, "win_windows.go combineFolderKey command")
	has(win, `deleteTree\(root, classes\+combineFolderKey\)`, "win_windows.go removes combineFolderKey")
	has(src("../electron/main.cjs"), `(?m)^const COMBINE_FOLDER_KEY = '\\\\Directory\\\\shell\\\\PDFEditor\.CombineFolder';`, "main.cjs COMBINE_FOLDER_KEY")
	// the name under HKCU\Software\RegisteredApplications is appName (not displayName), pointing at capsKey
	has(win, `setStr\(root, `+"`Software\\\\RegisteredApplications`"+`, appName, capsKey\)`, "win_windows.go RegisteredApplications value name")
	// the app: user data and local data folders are named by APP; the packed package.json keeps productName
	has(src("../electron/main.cjs"), `(?m)^const APP = 'PDF Editor';`, "main.cjs APP")
	var pk struct {
		ProductName string `json:"productName"`
	}
	if err := json.Unmarshal([]byte(src("../package.json")), &pk); err != nil || pk.ProductName != "PDF Editor" {
		t.Errorf("package.json productName: %q %v", pk.ProductName, err)
	}
	// and nothing that makes the public build's package differ in it: the export adds brand,
	// displayName, updateFeed, reportEndpoint - never productName - and pack.py copies productName as it is
	if exp := src("../scripts/export-public.py"); regexp.MustCompile(`pkg\[['"]productName['"]\]\s*=`).MatchString(exp) {
		t.Error("export-public.py changes productName")
	}
	has(src("../scripts/pack.py"), `'productName': pkg\['productName'\]`, "pack.py productName")
}

// DeepSeek 0.13.2 #1: the job the elevated step runs travels on its command line (fixed when
// Windows asks the person), not in the temp file a program of the same user could rewrite
// meanwhile; an apply without the package's checksum is refused.
func TestWorkerJobComesFromItsCommandLine(t *testing.T) {
	d := t.TempDir()
	jf := filepath.Join(d, "pdfed-setup-job-1.json")
	want := Job{Kind: "apply", Dir: `C:\Program Files\PDF Editor`, Zip: `C:\t\app.zip`, Sha: "ab12", Version: "0.14.0"}
	arg := jobArg(want)
	// (the temp file rewritten while the prompt is open)
	if err := writeJSON(jf, Job{Kind: "apply", Dir: want.Dir, Zip: `C:\evil.zip`, Sha: ""}); err != nil {
		t.Fatal(err)
	}
	got, err := workerJob(jf, arg)
	if err != nil {
		t.Fatal(err)
	}
	if got.Zip != want.Zip || got.Sha != want.Sha || got.Dir != want.Dir || got.Kind != want.Kind {
		t.Fatalf("got %+v, want the command line's %+v", got, want)
	}
	if _, err := workerJob(jf, ""); err == nil {
		t.Fatal("a worker started without its job on the command line must refuse")
	}
	if _, err := workerJob(jf, jobArg(Job{Kind: "apply", Dir: want.Dir, Zip: want.Zip})); err == nil {
		t.Fatal("an apply without the package's checksum must refuse")
	}
	if _, err := workerJob(jf, "!!not base64"); err == nil {
		t.Fatal("garbage must refuse")
	}
}

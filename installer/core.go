// PDF Editor Setup - the parts that don't depend on Windows: the payload inside the setup file,
// replacing a folder safely, applying an update package, going back a version.
package main

import (
	"archive/tar"
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	appName   = "PDF Editor"
	exeName   = "PDF Editor.exe"
	setupName = "PDF Editor Setup.exe"
	magic     = "PDFEDSET"
)

// What people see, and where new versions come from when nothing else says (build.py sets both
// with -X for the public build: "Greenline PDF Editor", its GitHub repository). Files, folders and
// registry keys keep appName's name, so an install is always found again.
var (
	displayName   = appName
	defaultSource = ""
)

// version of this setup build (-ldflags "-X main.version=...")
var version = "0.0.0"

// Meta describes the payload appended to the setup file.
type Meta struct {
	Version string `json:"version"`
	Runtime string `json:"runtime"`
	Total   int64  `json:"total"` // bytes of all files
	Files   int    `json:"files"`
}

// InstallInfo is install.json in the app folder.
type InstallInfo struct {
	Scope     string `json:"scope"` // "user" | "machine"
	Version   string `json:"version"`
	Runtime   string `json:"runtime"`
	Desktop   bool   `json:"desktop"`
	OpenWith  bool   `json:"openWith"`
	Installed string `json:"installed"`
}

// UpdateConf is update.json in the app folder: where new versions are published.
type UpdateConf struct {
	Source string `json:"source"`
}

// Payload is the compressed app inside the setup file. The layout at the end of the file:
// [exe][payload][meta json][8: meta len][8: payload len][8: magic]
type Payload struct {
	Path    string
	ExeLen  int64
	Off     int64
	Len     int64
	Meta    Meta
	present bool
}

func openPayload(self string) (*Payload, error) {
	f, err := os.Open(self)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	p := &Payload{Path: self, ExeLen: st.Size()}
	end := payloadEnd(f, st.Size())
	if end < 24 {
		return p, nil
	}
	tail := make([]byte, 24)
	if _, err := f.ReadAt(tail, end-24); err != nil {
		return nil, err
	}
	if string(tail[16:]) != magic {
		return p, nil // the helper copy: no payload
	}
	ml := int64(binary.LittleEndian.Uint64(tail[0:8]))
	pl := int64(binary.LittleEndian.Uint64(tail[8:16]))
	metaOff := end - 24 - ml
	if ml <= 0 || pl <= 0 || metaOff-pl < 0 {
		return nil, errors.New("the setup file is damaged (bad trailer)")
	}
	mb := make([]byte, ml)
	if _, err := f.ReadAt(mb, metaOff); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(mb, &p.Meta); err != nil {
		return nil, fmt.Errorf("the setup file is damaged (meta): %w", err)
	}
	p.Off = metaOff - pl
	p.Len = pl
	p.ExeLen = p.Off
	p.present = true
	return p, nil
}

// payloadEnd is where the trailer ends: the end of the file - or, when the setup was code-signed
// after it was built, where the signature (appended at the end, after up to 7 bytes of padding)
// starts. Without this a signed setup found no payload and acted as the uninstaller.
func payloadEnd(f *os.File, size int64) int64 {
	off, n := securityDir(f)
	if off <= 0 || n <= 0 || int64(off)+int64(n) > size {
		return size
	}
	b := make([]byte, 8)
	for pad := int64(0); pad < 8; pad++ {
		e := int64(off) - pad
		if e < 24 {
			break
		}
		if _, err := f.ReadAt(b, e-8); err == nil && string(b) == magic {
			return e
		}
	}
	return size
}

// securityDir reads the PE header's certificate table entry (file offset, size; 0 if none)
// and where that entry is in the file.
func securityDir(f io.ReaderAt) (uint32, uint32) {
	off, n, _ := securityDirAt(f)
	return off, n
}
func securityDirAt(f io.ReaderAt) (uint32, uint32, int64) {
	h := make([]byte, 4)
	if _, err := f.ReadAt(h, 0x3c); err != nil {
		return 0, 0, 0
	}
	pe := int64(binary.LittleEndian.Uint32(h))
	sig := make([]byte, 4)
	if _, err := f.ReadAt(sig, pe); err != nil || string(sig) != "PE\x00\x00" {
		return 0, 0, 0
	}
	opt := pe + 4 + 20
	m := make([]byte, 2)
	if _, err := f.ReadAt(m, opt); err != nil {
		return 0, 0, 0
	}
	var dirs int64
	switch binary.LittleEndian.Uint16(m) {
	case 0x20b: // PE32+
		dirs = opt + 112
	case 0x10b:
		dirs = opt + 96
	default:
		return 0, 0, 0
	}
	at := dirs + 4*8 // entry 4: the certificate table
	e := make([]byte, 8)
	if _, err := f.ReadAt(e, at); err != nil {
		return 0, 0, 0
	}
	return binary.LittleEndian.Uint32(e[0:4]), binary.LittleEndian.Uint32(e[4:8]), at
}

// Extract unpacks the payload into dst (which must not exist yet).
func (p *Payload) Extract(dst string, prog func(done, total int64)) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	dec, err := zstd.NewReader(io.NewSectionReader(f, p.Off, p.Len), zstd.WithDecoderMaxWindow(1<<30), zstd.WithDecoderMaxMemory(1<<31))
	if err != nil {
		return err
	}
	defer dec.Close()
	return untar(dec, dst, p.Meta.Total, prog)
}

func untar(r io.Reader, dst string, total int64, prog func(done, total int64)) error {
	tr := tar.NewReader(r)
	var done int64
	last := time.Time{}
	buf := make([]byte, 1<<20)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("the setup file is damaged: %w", err)
		}
		name, err := safeRel(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		out := filepath.Join(dst, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			for {
				n, rerr := tr.Read(buf)
				if n > 0 {
					if _, werr := w.Write(buf[:n]); werr != nil {
						w.Close()
						return werr
					}
					done += int64(n)
					if prog != nil && time.Since(last) > 80*time.Millisecond {
						prog(done, total)
						last = time.Now()
					}
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					w.Close()
					return fmt.Errorf("the setup file is damaged: %w", rerr)
				}
			}
			if err := w.Close(); err != nil {
				return err
			}
		}
	}
	if prog != nil {
		prog(total, total)
	}
	return nil
}

// safeRel keeps archive paths inside the target folder.
func safeRel(name string) (string, error) {
	n := strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./")
	n = strings.TrimSuffix(n, "/")
	if n == "" || n == "." {
		return "", nil
	}
	if strings.HasPrefix(n, "/") || strings.Contains(n, ":") {
		return "", fmt.Errorf("bad path in package: %s", name)
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", fmt.Errorf("bad path in package: %s", name)
		}
	}
	return filepath.FromSlash(n), nil
}

// copyExePart writes the setup program without its payload (the helper kept in the app folder
// for updates and uninstalling).
func (p *Payload) copyExePart(dst string) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	tmp := dst + ".tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, io.NewSectionReader(f, 0, p.ExeLen)); err != nil {
		w.Close()
		os.Remove(tmp)
		return err
	}
	// a signed setup: its header points at a signature this copy doesn't have - cleared (the
	// copy is simply unsigned, not "damaged")
	if off, n, at := securityDirAt(f); at > 0 && (off != 0 || n != 0) && int64(off) >= p.ExeLen {
		if _, err := w.WriteAt(make([]byte, 8), at); err != nil {
			w.Close()
			os.Remove(tmp)
			return err
		}
	}
	if err := w.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

// retry runs f until it works or the time is up (Explorer, antivirus or the closing app can
// hold files for a moment).
func retry(d time.Duration, f func() error) error {
	end := time.Now().Add(d)
	wait := 100 * time.Millisecond
	for {
		err := f()
		if err == nil || time.Now().After(end) {
			return err
		}
		time.Sleep(wait)
		if wait < time.Second {
			wait *= 2
		}
	}
}

// replaceDir fills a new copy of dir next to it, then swaps it in. The old copy is put back if
// the swap fails, so a failed install never leaves a half-written app behind.
func replaceDir(dir string, fill func(tmp string) error, keep []string) error {
	// (names of our own: a folder of the person's called "<name>.new" / ".old" is never touched)
	tag := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	tmp := dir + ".pdfed-new-" + tag
	// what an earlier, interrupted run left (our own names only)
	if left, _ := filepath.Glob(globEscape(dir) + ".pdfed-*"); len(left) > 0 {
		for _, l := range left {
			_ = os.RemoveAll(l)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if err := fill(tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	if _, err := os.Stat(dir); err != nil {
		if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		return nil
	}
	for _, k := range keep { // files of the old copy that stay (e.g. update.json)
		if _, err := os.Stat(filepath.Join(tmp, k)); err != nil {
			_ = copyFile(filepath.Join(dir, k), filepath.Join(tmp, k))
		}
	}
	old := dir + ".pdfed-old-" + tag
	if err := retry(8*time.Second, func() error { return os.Rename(dir, old) }); err != nil {
		// something still holds a file in the old folder (an Explorer window, an antivirus):
		// nothing is changed - copying over it could stop halfway and leave old and new mixed
		logf("rename of the old folder failed: %v", err)
		_ = os.RemoveAll(tmp)
		return fmt.Errorf("a file in %s is in use (an Explorer window showing that folder, or an antivirus scan) - close it and try again; nothing was changed", dir)
	}
	if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
		_ = os.Rename(old, dir)
		_ = os.RemoveAll(tmp)
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		logf("old folder left behind: %v", err)
	}
	return nil
}

// globEscape: a folder name used literally in a pattern ([, *, ? are pattern characters).
func globEscape(s string) string {
	return strings.NewReplacer("[", "[[]", "*", "[*]", "?", "[?]").Replace(s)
}

func copyFile(src, dst string) error {
	r, err := os.Open(src)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	w, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, r); err != nil {
		w.Close()
		return err
	}
	return w.Close()
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		out := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(out, 0o755)
		}
		return retry(3*time.Second, func() error { return copyFile(p, out) })
	})
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyHashed copies src to dst and returns the SHA-256 of the bytes written (read once).
func copyHashed(src, dst string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), in); err != nil {
		out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func readJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func readInstall(dir string) (*InstallInfo, error) {
	var ii InstallInfo
	if err := readJSON(filepath.Join(dir, "install.json"), &ii); err != nil {
		return nil, err
	}
	return &ii, nil
}

// versionLess compares dotted numbers: 0.3.10 > 0.3.9.
func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// appVersionAt reads the version of the app files in dir/resources/<name>.
func appVersionAt(dir, name string) string {
	var pkg struct {
		Version string `json:"version"`
	}
	if readJSON(filepath.Join(dir, "resources", name, "package.json"), &pkg) != nil {
		return ""
	}
	return pkg.Version
}

// applyApp puts a downloaded update package (the app part, resources\app) in place.
// The previous app part stays as resources\app.old for going back.
func applyApp(dir, zipPath, sha, want string) error {
	res := filepath.Join(dir, "resources")
	// The package is copied into the install folder first, checked, and unpacked from that copy. The
	// downloaded file sits in the person's own AppData: for an install for everyone (Program Files,
	// this side running with admin rights) it was checked there and then opened again there - anyone
	// signed in could have swapped it between the two and had their files installed for every user.
	// The copy in resources\ is where only administrators can write.
	pkg := filepath.Join(res, "app.pkg")
	_ = os.Remove(pkg)
	got, err := copyHashed(zipPath, pkg)
	defer os.Remove(pkg)
	if err != nil {
		return fmt.Errorf("can't read the update package: %w", err)
	}
	if sha != "" && !strings.EqualFold(got, sha) {
		return errors.New("the update package is damaged (checksum doesn't match)")
	}
	cur, nw, old := filepath.Join(res, "app"), filepath.Join(res, "app.new"), filepath.Join(res, "app.old")
	_ = os.RemoveAll(nw)
	if err := extractZip(pkg, nw); err != nil {
		_ = os.RemoveAll(nw)
		return fmt.Errorf("can't unpack the update: %w", err)
	}
	v := appVersionAt(dir, "app.new")
	if v == "" || (want != "" && v != want) {
		_ = os.RemoveAll(nw)
		return fmt.Errorf("the update package holds version %q, expected %q", v, want)
	}
	// (the version before the last one makes room; when it can't, that is the reason given - not
	// "files in use" from the rename after it)
	if err := retry(5*time.Second, func() error { return os.RemoveAll(old) }); err != nil {
		_ = os.RemoveAll(nw)
		return fmt.Errorf("the previous version's folder (resources\\app.old) couldn't be removed - the version you have is unchanged: %w", err)
	}
	if err := retry(20*time.Second, func() error { return os.Rename(cur, old) }); err != nil {
		_ = os.RemoveAll(nw)
		return fmt.Errorf(displayName+"'s files are still in use: %w", err)
	}
	if err := retry(5*time.Second, func() error { return os.Rename(nw, cur) }); err != nil {
		_ = os.Rename(old, cur)
		_ = os.RemoveAll(nw)
		return err
	}
	// (the version the package really holds - also when the helper was started without --version)
	setInstalledVersion(dir, v)
	return nil
}

// rollbackApp swaps resources\app and resources\app.old.
func rollbackApp(dir string) error {
	res := filepath.Join(dir, "resources")
	cur, old, tmp := filepath.Join(res, "app"), filepath.Join(res, "app.old"), filepath.Join(res, "app.swap")
	if appVersionAt(dir, "app.old") == "" {
		return errors.New("there is no previous version to go back to")
	}
	_ = os.RemoveAll(tmp)
	if err := retry(20*time.Second, func() error { return os.Rename(cur, tmp) }); err != nil {
		return fmt.Errorf(displayName+"'s files are still in use: %w", err)
	}
	if err := os.Rename(old, cur); err != nil {
		_ = os.Rename(tmp, cur)
		return err
	}
	if err := os.Rename(tmp, old); err != nil {
		logf("rollback: keeping the newer version failed: %v", err)
	}
	setInstalledVersion(dir, appVersionAt(dir, "app"))
	return nil
}

func setInstalledVersion(dir, v string) {
	if v == "" {
		return
	}
	if ii, err := readInstall(dir); err == nil {
		ii.Version = v
		_ = writeJSON(filepath.Join(dir, "install.json"), ii)
	}
	setRegistryVersion(dir, v)
}

func extractZip(zipPath, dst string) error {
	z, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer z.Close()
	for _, f := range z.File {
		name, err := safeRel(f.Name)
		if err != nil {
			return err
		}
		if name == "" || strings.HasSuffix(f.Name, "/") {
			continue
		}
		out := filepath.Join(dst, name)
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		r, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(out)
		if err != nil {
			r.Close()
			return err
		}
		_, cerr := io.Copy(w, r)
		r.Close()
		if werr := w.Close(); cerr == nil {
			cerr = werr
		}
		if cerr != nil {
			return cerr
		}
	}
	return nil
}

// dirSizeKB for the "Installed apps" list.
func dirSizeKB(dir string) uint32 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			n += fi.Size()
		}
		return nil
	})
	return uint32(n / 1024)
}

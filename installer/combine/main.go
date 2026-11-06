// PDF Editor Combine - what Explorer runs for "Combine with PDF Editor" (several PDFs selected >
// right-click).
//
// Windows runs the command once per selected file, all at the same moment: 80 files = 80 starts.
// Up to 0.8.5 each of them was a whole PDF Editor start (the Electron runtime), each handing its
// file to the copy that started first. With many files that is dozens of heavy starts at once, and
// a copy that was still starting (busy for more than a few seconds, no window yet) was taken for
// hung by the others and closed by them (Chromium's single-instance rule) - the Merge dialog never
// came. This small program does it instead: it leaves the file's path in the spool folder
// (%LOCALAPPDATA%\PDF Editor\combine, one small file per PDF) and exits; the first of them starts
// PDF Editor once (--combine-spool), which picks them all up into one Merge dialog. A copy already
// running finds them there by itself too.
//
//	"PDF Editor Combine.exe" "<file.pdf>"        (what Explorer runs; more files may follow)
//	"PDF Editor Combine.exe" --selftest           (PDF Editor checks it can run, before using it)
//	--profile=<name>  the app's --profile (tests); --app=<path>  the app to start (tests)
//
// It lives in resources\app\bin, so it comes with the app updates; the app is three folders up.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var version = "dev"

const appExe = "PDF Editor.exe"

func main() {
	var files []string
	profile, app := "", ""
	for _, a := range os.Args[1:] {
		switch {
		case a == "--selftest":
			fmt.Println("pdf-editor-combine ok " + version)
			return
		case strings.HasPrefix(a, "--profile="):
			profile = cleanProfile(a[len("--profile="):])
		case strings.HasPrefix(a, "--app="):
			app = a[len("--app="):]
		case strings.HasPrefix(a, "--"):
		default:
			files = append(files, a)
		}
	}
	if app == "" {
		if self, err := os.Executable(); err == nil {
			app = filepath.Join(filepath.Dir(self), "..", "..", "..", appExe)
		}
	}
	dir := spoolDir(profile)
	allowForeground()
	// the files into the spool; one that can't go there is handed over the old way
	var direct []string
	if err := os.MkdirAll(dir, 0o755); err != nil {
		direct = files
	} else {
		for i, f := range files {
			if abs, err := filepath.Abs(f); err != nil || spool(dir, abs, i) != nil {
				direct = append(direct, f)
			}
		}
	}
	if len(direct) > 0 {
		args := append([]string{"--combine"}, direct...)
		if _, err := launch(app, profile, args); err != nil {
			logf(dir, "can't start %s: %v", app, err)
		}
		return
	}
	// PDF Editor is started by one of them only: the one that makes launch.lock. The lock names the
	// process it started (or this one, while starting it); a lock whose process has ended, or older
	// than 90 s, is taken over. (Two taking over one old lock at once both start the app - harmless:
	// the files stay in the spool until a window is up, see main.cjs takeSpool.)
	lock := filepath.Join(dir, "launch.lock")
	for try := 0; try < 2; try++ {
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d %d", os.Getpid(), time.Now().UnixMilli())
			pid, lerr := launch(app, profile, []string{"--combine-spool"})
			if lerr != nil {
				f.Close()
				os.Remove(lock)
				logf(dir, "can't start %s: %v", app, lerr)
				return
			}
			f.Truncate(0)
			f.Seek(0, 0)
			fmt.Fprintf(f, "%d %d", pid, time.Now().UnixMilli())
			f.Close()
			return
		}
		if !stale(lock) {
			return
		}
		logf(dir, "launch.lock of an ended start taken over")
		os.Remove(lock)
	}
}

// cleanProfile: as the app does (letters, digits, _ and - only)
func cleanProfile(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// spoolDir: <the app's local folder>\combine - %LOCALAPPDATA%\PDF Editor on Windows (the
// roaming folder can be on a server), the config folder elsewhere (tests)
func spoolDir(profile string) string {
	base := ""
	if runtime.GOOS == "windows" {
		base = os.Getenv("LOCALAPPDATA")
	}
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	d := filepath.Join(base, "PDF Editor")
	if profile != "" && profile != "default" {
		d = filepath.Join(d, "profile-"+profile)
	}
	return filepath.Join(d, "combine")
}

// spool: one file per PDF, written whole under another name first (the app never reads half a name)
func spool(dir, path string, i int) error {
	name := fmt.Sprintf("%d-%d-%d", time.Now().UnixNano(), os.Getpid(), i)
	tmp := filepath.Join(dir, name+".tmp")
	if err := os.WriteFile(tmp, []byte(path), 0o644); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name+".path")); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func launch(app, profile string, args []string) (int, error) {
	if profile != "" {
		args = append(args, "--profile="+profile)
	}
	cmd := exec.Command(app, args...)
	cmd.Dir = filepath.Dir(app)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	cmd.Process.Release()
	return pid, nil
}

func stale(lock string) bool {
	st, err := os.Stat(lock)
	if err != nil {
		return true // gone meanwhile: try again
	}
	age := time.Since(st.ModTime())
	if age > 90*time.Second {
		return true
	}
	b, _ := os.ReadFile(lock)
	var pid int
	var at int64
	if n, _ := fmt.Sscanf(string(b), "%d %d", &pid, &at); n < 1 || pid <= 0 {
		return age > 15*time.Second // (being written)
	}
	return !alive(pid)
}

// ours: the name of PDF Editor or of this program (a lock's process number used again by another
// program is not "still starting PDF Editor")
func ours(image string) bool {
	b := strings.ToLower(filepath.Base(strings.ReplaceAll(image, `\`, "/")))
	return b == strings.ToLower(appExe) || b == "pdf editor combine.exe"
}

// logf: only what went wrong or was unusual (a whole selection writes nothing here)
func logf(dir, format string, a ...any) {
	p := filepath.Join(dir, "combine.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 256<<10 {
		os.Remove(p)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%d] %s\r\n", time.Now().Format("2006-01-02 15:04:05.000"), os.Getpid(), fmt.Sprintf(format, a...))
}

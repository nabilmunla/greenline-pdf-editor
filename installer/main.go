// PDF Editor Setup: one file that installs PDF Editor (per user or for everyone), and - as the
// copy kept in the app folder - applies updates, goes back a version and uninstalls.
//
//	PDF Editor Setup.exe                         install (window; plain prompts without WebView2)
//	  --silent [--all-users] [--dir D] [--no-desktop] [--no-open-with] [--updates \\server\share]
//	  --update --dir D --wait PID --relaunch     full update (new Electron runtime), from the app
//	  --apply ZIP --sha256 H --version V --dir D --wait PID [--relaunch]   app update, from the app
//	  --rollback --dir D --wait PID [--relaunch] back to the previous app version, from the app
//	  --uninstall [--dir D] [--silent]           (also: the helper copy started with no arguments)
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Options are the choices made in the window (or on the command line).
type Options struct {
	Scope    string `json:"scope"` // "user" | "machine"
	Dir      string `json:"dir"`
	Desktop  bool   `json:"desktop"`
	OpenWith bool   `json:"openWith"`
	Source   string `json:"source"` // updates folder; "" = no automatic updates
}

var errRunning = errors.New(displayName + " is open")

type progressFn func(pct float64, stage string)

var (
	logMu   sync.Mutex
	logPath string
)

func initLog() {
	logPath = filepath.Join(os.TempDir(), "PDF Editor Setup.log")
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > 1<<20 {
		_ = os.Remove(logPath)
	}
}

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%d] %s\n", time.Now().Format("2006-01-02 15:04:05"), os.Getpid(), fmt.Sprintf(format, a...))
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// plainUI: --plain - plain Windows prompts instead of the setup window (if that window misbehaves)
var plainUI bool

// canWrite: can this process create files in dir (made if missing)?
func canWrite(dir string) bool {
	probe := dir
	for !fileExists(probe) {
		parent := filepath.Dir(probe)
		if parent == probe {
			return false
		}
		probe = parent
	}
	f, err := os.CreateTemp(probe, ".pdfed-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}

// looksInstalled: never delete a folder that isn't a PDF Editor install.
func looksInstalled(dir string) bool {
	d := filepath.Clean(dir)
	if len(d) < 6 || filepath.Dir(d) == d {
		return false
	}
	return fileExists(filepath.Join(d, exeName)) && fileExists(filepath.Join(d, "install.json"))
}

// olderCopy: a PDF Editor folder from before the setup existed (copied by hand, or by the old
// install script) - the app is there, an install record isn't. Its version, or "" when the
// folder is anything else. Strict on purpose: only such a folder may be replaced like an install.
func olderCopy(dir string) string {
	d := filepath.Clean(dir)
	if len(d) < 6 || filepath.Dir(d) == d || fileExists(filepath.Join(d, "install.json")) || !fileExists(filepath.Join(d, exeName)) {
		return ""
	}
	var pk struct {
		ProductName string `json:"productName"`
		Main        string `json:"main"`
		Version     string `json:"version"`
	}
	if readJSON(filepath.Join(d, "resources", "app", "package.json"), &pk) != nil || pk.ProductName != appName || pk.Main != "electron/main.cjs" {
		return ""
	}
	if pk.Version == "" {
		return "(older)"
	}
	return pk.Version
}

func doInstall(p *Payload, o Options, prog progressFn) error {
	if !p.present {
		return errors.New("this copy of the setup has no app inside")
	}
	if o.Dir == "" {
		o.Dir = defaultDir(o.Scope)
	}
	o.Dir = filepath.Clean(o.Dir)
	exe := filepath.Join(o.Dir, exeName)
	if fileExists(exe) && exeLocked(exe) {
		return errRunning
	}
	if fileExists(o.Dir) && !looksInstalled(o.Dir) && olderCopy(o.Dir) == "" {
		if entries, err := os.ReadDir(o.Dir); err != nil || len(entries) > 0 {
			return fmt.Errorf("%s already has other files in it - choose an empty or new folder", o.Dir)
		}
	}
	logf("install %s to %s (%s) desktop=%v openWith=%v source=%q", p.Meta.Version, o.Dir, o.Scope, o.Desktop, o.OpenWith, o.Source)
	prog(0.01, "Copying files")
	ii := InstallInfo{Scope: o.Scope, Version: p.Meta.Version, Runtime: p.Meta.Runtime, Desktop: o.Desktop, OpenWith: o.OpenWith, Installed: time.Now().Format(time.RFC3339)}
	// everything the folder needs goes into the new copy before it is swapped in: stopped
	// halfway (power cut, error), the old folder is still whole - or there is none yet
	err := replaceDir(o.Dir, func(tmp string) error {
		if err := p.Extract(tmp, func(d, t int64) {
			if t <= 0 {
				t = 1
			}
			prog(0.01+0.85*float64(d)/float64(t), "Copying files")
		}); err != nil {
			return err
		}
		prog(0.88, "Finishing")
		if err := p.copyExePart(filepath.Join(tmp, setupName)); err != nil {
			return fmt.Errorf("can't write the uninstaller: %w", err)
		}
		if err := writeJSON(filepath.Join(tmp, "install.json"), ii); err != nil {
			return err
		}
		// (an empty one too, where the build has an address of its own: "no updates" was chosen -
		// without the file the app would go to that address anyway)
		if strings.TrimSpace(o.Source) != "" || defaultSource != "" {
			if err := writeJSON(filepath.Join(tmp, "update.json"), UpdateConf{Source: strings.TrimSpace(o.Source)}); err != nil {
				return err
			}
		}
		return nil
	}, nil)
	if err != nil {
		return err
	}
	prog(0.92, "Finishing")
	prog(0.94, "Creating shortcuts")
	if err := makeShortcuts(o.Dir, ii); err != nil {
		logf("shortcuts: %v", err)
	}
	prog(0.97, "Registering with Windows")
	if err := registerApp(o.Dir, ii); err != nil {
		logf("register: %v", err)
	}
	notifyAssocChanged()
	prog(1, "Done")
	logf("installed")
	return nil
}

func doUninstall(dir string, prog progressFn) error {
	dir = filepath.Clean(dir)
	if !looksInstalled(dir) {
		return fmt.Errorf("%s doesn't look like a "+displayName+" installation - nothing was removed", dir)
	}
	if exeLocked(filepath.Join(dir, exeName)) {
		return errRunning
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	logf("uninstall %s (%s)", dir, scope)
	prog(0.1, "Removing shortcuts")
	removeShortcuts(scope, dir)
	prog(0.2, "Removing from Windows")
	unregisterApp(dir, scope)
	notifyAssocChanged()
	prog(0.3, "Removing files")
	err := retry(10*time.Second, func() error { return os.RemoveAll(dir) })
	// what an interrupted install of ours left next to it (only our own names)
	if left, _ := filepath.Glob(globEscape(dir) + ".pdfed-*"); len(left) > 0 {
		for _, l := range left {
			_ = os.RemoveAll(l)
		}
	}
	if err != nil {
		return fmt.Errorf("some files couldn't be removed: %w", err)
	}
	prog(1, "Done")
	logf("uninstalled")
	return nil
}

// removeUserData: the person's settings, recent files, AI keys, backups, unsaved-work copies and
// downloaded updates (everything in both PDF Editor data folders).
func removeUserData() {
	for _, d := range userDataDirs() {
		if d != "" && strings.HasSuffix(filepath.Clean(d), appName) {
			_ = os.RemoveAll(d)
		}
	}
}

// Job is work handed to an elevated copy of this program (installs for everyone, updates of a
// copy in Program Files).
type Job struct {
	Kind    string  `json:"kind"` // install | uninstall | apply | rollback
	Opts    Options `json:"opts"`
	Dir     string  `json:"dir"`
	Zip     string  `json:"zip"`
	Sha     string  `json:"sha"`
	Version string  `json:"version"`
}

type jobResult struct {
	OK      bool   `json:"ok"`
	Err     string `json:"err"`
	Running bool   `json:"running"`
}

func runJob(p *Payload, j Job, prog progressFn) error {
	switch j.Kind {
	case "install":
		return doInstall(p, j.Opts, prog)
	case "uninstall":
		return doUninstall(j.Dir, prog)
	case "apply", "rollback":
		// (checked here too, with admin rights: the job file came through the temp folder - it only
		// ever changes a PDF Editor install's own app part)
		if !looksInstalled(j.Dir) {
			return fmt.Errorf("%s doesn't look like a "+displayName+" installation - nothing was changed", j.Dir)
		}
		// (checked here too: an elevated helper also sees copies other people on this PC have open -
		// and our own copy's last processes still ending: up to 0.8.6 this looked once, a moment
		// after the app closed, and gave up - "PDF Editor is open" on Nabil's PC, 4 Nov, twice)
		if !waitAppGone(filepath.Join(j.Dir, exeName), 30*time.Second) {
			return errRunning
		}
		if j.Kind == "apply" {
			return applyApp(j.Dir, j.Zip, j.Sha, j.Version)
		}
		return rollbackApp(j.Dir)
	}
	return fmt.Errorf("unknown job %q", j.Kind)
}

// runWorker is the elevated side: does the job, reports progress and the result in files.
func runWorker(p *Payload, jobFile string) int {
	var j Job
	if err := readJSON(jobFile, &j); err != nil {
		logf("worker: %v", err)
		return 2
	}
	progFile := jobFile + ".progress"
	err := runJob(p, j, func(pct float64, stage string) {
		_ = os.WriteFile(progFile, []byte(fmt.Sprintf("%.4f|%s", pct, stage)), 0o644)
	})
	res := jobResult{OK: err == nil}
	if err != nil {
		res.Err = err.Error()
		res.Running = errors.Is(err, errRunning)
		logf("worker %s failed: %v", j.Kind, err)
	}
	_ = writeJSON(jobFile+".result", res)
	if err != nil {
		return 1
	}
	return 0
}

// runAs does the job here, or in an elevated copy when this process can't write there.
func runAs(p *Payload, j Job, elevate bool, prog progressFn) error {
	if !elevate || isElevated() {
		return runJob(p, j, prog)
	}
	return runElevated(j, prog)
}

func needsElevation(dir string, scope string) bool {
	if isElevated() {
		return false
	}
	return scope == "machine" || !canWrite(dir)
}

func main() {
	initLog()
	self, err := os.Executable()
	if err != nil {
		fatal("Can't find the setup program: " + err.Error())
	}
	p, err := openPayload(self)
	if err != nil {
		fatal(err.Error())
	}
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	var (
		silent    = fs.Bool("silent", false, "")
		allUsers  = fs.Bool("all-users", false, "")
		dir       = fs.String("dir", "", "")
		noDesktop = fs.Bool("no-desktop", false, "")
		noOpen    = fs.Bool("no-open-with", false, "")
		updates   = fs.String("updates", "", "")
		update    = fs.Bool("update", false, "")
		apply     = fs.String("apply", "", "")
		sha       = fs.String("sha256", "", "")
		ver       = fs.String("version", "", "")
		rollback  = fs.Bool("rollback", false, "")
		uninstall = fs.Bool("uninstall", false, "")
		wait      = fs.Int("wait", 0, "")
		relaunch  = fs.Bool("relaunch", false, "")
		worker    = fs.String("worker", "", "")
		tempCopy  = fs.Bool("temp-copy", false, "")
		plain     = fs.Bool("plain", false, "")
	)
	if err := fs.Parse(os.Args[1:]); err != nil {
		fatal("Unknown option: " + strings.Join(os.Args[1:], " "))
	}
	plainUI = *plain
	logf("start %s %q payload=%v elevated=%v", version, os.Args[1:], p.present, isElevated())
	cleanTemp(self)
	switch {
	case *worker != "":
		os.Exit(runWorker(p, *worker))
	case *apply != "":
		os.Exit(cmdApply(p, *apply, *sha, *ver, *dir, *wait, *relaunch))
	case *rollback:
		os.Exit(cmdRollback(p, *dir, *wait, *relaunch))
	case *update:
		os.Exit(cmdUpdate(p, *dir, *wait, *relaunch))
	case !p.present && !*uninstall && len(os.Args) > 1:
		// the uninstaller copy started with options it doesn't know: do nothing (never a silent uninstall)
		logf("no payload and no --uninstall: nothing to do")
		os.Exit(2)
	case !*uninstall && !p.present && !looksInstalled(filepath.Dir(self)):
		// a setup file without its app part (cut short when copied, or changed afterwards): it
		// says so - it never turns into the uninstaller of whatever is installed
		logf("no payload, not in an install folder")
		messageBox("This setup file is incomplete (the app part is missing) - it may not have been copied completely. Get it again from where you got it.", mbWarn)
		os.Exit(2)
	case *uninstall || !p.present:
		d := *dir
		if d == "" {
			d = filepath.Dir(self)
			if !looksInstalled(d) {
				if found, _ := findInstalled(); found != "" {
					d = found
				}
			}
		}
		os.Exit(cmdUninstall(self, d, *silent, *tempCopy))
	case *silent:
		o := Options{Scope: "user", Dir: *dir, Desktop: !*noDesktop, OpenWith: !*noOpen, Source: *updates}
		if *allUsers {
			o.Scope = "machine"
		}
		if o.Source == "" {
			o.Source = detectSource(self)
		}
		if o.Dir == "" {
			if found, ii := findInstalled(); found != "" && ii != nil && ii.Scope == o.Scope {
				o.Dir = found
			}
		}
		if o.Dir != "" {
			if msg := checkDir(o.Scope, o.Dir); msg != "" {
				logf("silent install: %s", msg)
				os.Exit(1)
			}
		}
		// a reinstall without --updates keeps the updates folder the copy there already has (run
		// from Downloads, the setup finds none of its own - update.json was dropped and the copy
		// stopped looking for new versions without a word)
		if o.Source == "" {
			if kept, said := keptSourceOf(orDefault(o.Dir, o.Scope)); said {
				o.Source = kept
			} else {
				// (the public build: its download page - nobody should have to know what to type)
				o.Source = defaultSource
			}
		}
		if o.Scope == "user" && otherAdmin() {
			// (started with another account's admin rights: "just me" would be that account)
			logf("silent install: per-user install refused - running as another account's admin; use --all-users")
			os.Exit(1)
		}
		err := runAs(p, Job{Kind: "install", Opts: o}, needsElevation(orDefault(o.Dir, o.Scope), o.Scope), func(float64, string) {})
		if err != nil {
			logf("silent install failed: %v", err)
			os.Exit(1)
		}
		os.Exit(0)
	default:
		os.Exit(cmdInstall(p, self))
	}
}

// cleanTemp removes temporary uninstaller copies left by earlier runs (a program can't delete
// itself; the next run tidies up).
func cleanTemp(self string) {
	old, _ := filepath.Glob(filepath.Join(os.TempDir(), "PDF Editor Uninstall *.exe"))
	for _, f := range old {
		if !strings.EqualFold(f, self) {
			if fi, err := os.Stat(f); err == nil && time.Since(fi.ModTime()) > time.Minute {
				_ = os.Remove(f)
			}
		}
	}
	// job files of an admin-rights step whose setup window was closed by force (the window removes
	// its own when it ends): a day old, they belong to no running setup
	jobs, _ := filepath.Glob(filepath.Join(os.TempDir(), "pdfed-setup-job-*"))
	for _, f := range jobs {
		if fi, err := os.Stat(f); err == nil && time.Since(fi.ModTime()) > 24*time.Hour {
			_ = os.Remove(f)
		}
	}
}

func orDefault(dir, scope string) string {
	if dir == "" {
		return defaultDir(scope)
	}
	return dir
}

// keptSource: the updates folder an install in dir already uses ("" = none, or no install there).
func keptSource(dir string) string {
	src, _ := keptSourceOf(dir)
	return src
}

// keptSourceOf: as keptSource, and whether the install says so itself (its update.json - "" there
// means no updates, chosen; no update.json means nothing was chosen)
func keptSourceOf(dir string) (string, bool) {
	if !looksInstalled(dir) || !fileExists(filepath.Join(dir, "update.json")) {
		return "", false
	}
	var uc UpdateConf
	_ = readJSON(filepath.Join(dir, "update.json"), &uc)
	return strings.TrimSpace(uc.Source), true
}

// detectSource: started from the company's updates folder (it holds latest.json)? Then that's
// where this copy will look for new versions - as \\server\share, not a drive letter.
func detectSource(self string) string {
	d := filepath.Dir(self)
	if fileExists(filepath.Join(d, "latest.json")) {
		return toUNC(d)
	}
	return ""
}

// waitClosed waits for the app to close; false: it is still (or again) open.
func waitClosed(dir string, pid int) bool {
	if pid > 0 {
		waitPid(pid, 2*time.Minute)
	}
	return waitAppGone(filepath.Join(dir, exeName), 30*time.Second)
}

var appProcsFn = appProcs // (tests)

// waitAppGone waits up to d for every PDF Editor started from this exe to end (with admin rights:
// any account's); false: one still runs. An app-part update swaps resources\app only - the exe
// itself stays - so a program merely reading the exe (an antivirus scan, Explorer taking its
// icon) doesn't stop it; that is only noted in the log. What it waited for goes in the log.
func waitAppGone(exe string, d time.Duration) bool {
	t0 := time.Now()
	logged := false
	for {
		mine, unseen := appProcsFn(exe)
		if len(mine) == 0 {
			if logged {
				logf("PDF Editor ended %.1f s later", time.Since(t0).Seconds())
			}
			return true
		}
		if !logged || time.Since(t0) > d {
			held := ""
			if exeLocked(exe) {
				held = " - the exe is held by: " + fileHolders(exe)
			}
			if time.Since(t0) > d {
				logf("PDF Editor still running after %.0f s: %s (others not visible here: %s)%s", d.Seconds(), strings.Join(mine, ", "), strings.Join(unseen, ", "), held)
				return false
			}
			logf("waiting for PDF Editor to end: %s (others not visible here: %s)%s", strings.Join(mine, ", "), strings.Join(unseen, ", "), held)
			logged = true
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func cmdApply(p *Payload, zip, sha, ver, dir string, pid int, relaunch bool) int {
	if dir == "" || !fileExists(filepath.Join(dir, exeName)) {
		logf("apply: bad folder %q", dir)
		return 2
	}
	// (not now: "Restart now" still starts the app again - it was left closed, with no word; the app
	// says at its next start that the update didn't finish, and offers it again)
	later := func(why string) int {
		logf("apply: %s - update left for later", why)
		if relaunch {
			_ = launchApp(filepath.Join(dir, exeName))
		}
		return 3
	}
	if !waitClosed(dir, pid) {
		// opened again meanwhile (or someone else has it open): not now - the app offers the
		// downloaded update again next time
		return later(displayName + " is open again")
	}
	err := runAs(p, Job{Kind: "apply", Dir: dir, Zip: zip, Sha: sha, Version: ver}, needsElevation(filepath.Join(dir, "resources"), ""), func(float64, string) {})
	if errors.Is(err, errRunning) {
		// (an install for everyone: also a copy someone else on this PC has open)
		return later(displayName + " is open")
	}
	if err != nil {
		logf("apply failed: %v", err)
		messageBox(displayName+" couldn't be updated:\n\n"+err.Error()+"\n\nThe version you had is unchanged.", mbWarn)
	} else {
		logf("applied %s", ver)
		_ = os.Remove(zip)
	}
	if relaunch {
		_ = launchApp(filepath.Join(dir, exeName))
	}
	if err != nil {
		return 1
	}
	return 0
}

func cmdRollback(p *Payload, dir string, pid int, relaunch bool) int {
	if !waitClosed(dir, pid) {
		messageBox(displayName+" is still open, so it can't go back to the previous version now. Close it and try again.", mbWarn)
		return 3
	}
	err := runAs(p, Job{Kind: "rollback", Dir: dir}, needsElevation(filepath.Join(dir, "resources"), ""), func(float64, string) {})
	if err != nil {
		logf("rollback failed: %v", err)
		messageBox(displayName+" couldn't go back to the previous version:\n\n"+err.Error(), mbWarn)
	}
	if relaunch {
		_ = launchApp(filepath.Join(dir, exeName))
	}
	if err != nil {
		return 1
	}
	return 0
}

// cmdUpdate: this whole setup file, run by the app when a new version also brings a new runtime.
// Same choices as before; no window.
func cmdUpdate(p *Payload, dir string, pid int, relaunch bool) int {
	ii, err := readInstall(dir)
	if err != nil || !p.present {
		logf("update: not an install (%v)", err)
		return 2
	}
	if !waitClosed(dir, pid) {
		logf("update: PDF Editor is open again - left for later")
		return 3
	}
	var uc UpdateConf
	_ = readJSON(filepath.Join(dir, "update.json"), &uc)
	o := Options{Scope: ii.Scope, Dir: dir, Desktop: ii.Desktop, OpenWith: ii.OpenWith, Source: uc.Source}
	err = runAs(p, Job{Kind: "install", Opts: o}, needsElevation(dir, ii.Scope), func(float64, string) {})
	if err != nil {
		logf("update failed: %v", err)
		messageBox(displayName+" couldn't be updated:\n\n"+err.Error()+"\n\nThe version you had is unchanged.", mbWarn)
	}
	if relaunch {
		_ = launchApp(filepath.Join(dir, exeName))
	}
	if err != nil {
		return 1
	}
	return 0
}

// cmdUninstall: run from a temporary copy (a program can't delete its own folder while it runs
// from it).
func cmdUninstall(self, dir string, silent, tempCopy bool) int {
	if !looksInstalled(dir) {
		if !silent {
			messageBox(displayName+" isn't installed here:\n"+dir, mbInfo)
		}
		return 2
	}
	inside := strings.HasPrefix(strings.ToLower(filepath.Clean(self)), strings.ToLower(filepath.Clean(dir))+string(os.PathSeparator))
	if inside && !tempCopy && silent {
		// IT tools wait for this process and read its exit code (a reinstall may follow at once):
		// the running program is moved out of the folder (Windows allows that on the same drive)
		// and the uninstall is done here, start to end
		moved := filepath.Join(os.TempDir(), fmt.Sprintf("PDF Editor Uninstall %d.exe", time.Now().UnixNano()%1e6))
		if err := os.Rename(self, moved); err == nil {
			inside = false
			logf("silent uninstall: running from %s", moved)
		}
	}
	if inside && !tempCopy {
		tmp := filepath.Join(os.TempDir(), fmt.Sprintf("PDF Editor Uninstall %d.exe", time.Now().UnixNano()%1e6))
		if err := copyFile(self, tmp); err == nil {
			args := []string{"--uninstall", "--temp-copy", "--dir", dir}
			if silent {
				args = append(args, "--silent")
			}
			if err := launch(tmp, args...); err == nil {
				return 0
			}
		}
		logf("couldn't start a temporary copy; uninstalling from here")
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	if silent {
		if err := runAs(nil, Job{Kind: "uninstall", Dir: dir}, needsElevation(dir, scope), func(float64, string) {}); err != nil {
			logf("silent uninstall failed: %v", err)
			return 1
		}
		return 0
	}
	return uninstallUI(dir, scope)
}

func cmdInstall(p *Payload, self string) int {
	st := installState(p, self)
	return installUI(p, st)
}

// UIState is what the window starts with.
type UIState struct {
	Mode     string            `json:"mode"` // install | uninstall
	Version  string            `json:"version"`
	Existing *Existing         `json:"existing"`
	Dirs     map[string]string `json:"dirs"`
	Source   string            `json:"source"`
	Opts     Options           `json:"opts"`
}

type Existing struct {
	Version string `json:"version"`
	Dir     string `json:"dir"`
	Scope   string `json:"scope"`
	Source  string `json:"source"`
}

func installState(p *Payload, self string) UIState {
	st := UIState{Mode: "install", Version: p.Meta.Version, Dirs: map[string]string{"user": defaultDir("user"), "machine": defaultDir("machine")}}
	st.Source = detectSource(self)
	// (the public build: its download page filled in - nobody should have to know what to type)
	st.Opts = Options{Scope: "user", Dir: st.Dirs["user"], Desktop: true, OpenWith: true, Source: orIf(st.Source, defaultSource)}
	if otherAdmin() {
		// (started with another account's admin rights: "just me" would mean that account)
		st.Opts.Scope, st.Opts.Dir = "machine", st.Dirs["machine"]
	}
	if dir, ii := findInstalled(); dir != "" && ii != nil {
		var uc UpdateConf
		_ = readJSON(filepath.Join(dir, "update.json"), &uc)
		st.Existing = &Existing{Version: ii.Version, Dir: dir, Scope: ii.Scope, Source: uc.Source}
		kept, said := keptSourceOf(dir)
		if !said {
			kept = defaultSource
		}
		st.Opts = Options{Scope: ii.Scope, Dir: dir, Desktop: ii.Desktop, OpenWith: ii.OpenWith, Source: kept}
		if st.Source != "" {
			st.Opts.Source = st.Source
		}
	} else {
		// no install of the setup's own, but a hand-made older copy in a usual place: offered as
		// the one to update (same folder, same reach), so there aren't two copies side by side
		for _, sc := range []string{"machine", "user"} {
			if v := olderCopy(st.Dirs[sc]); v != "" {
				st.Existing = &Existing{Version: v, Dir: st.Dirs[sc], Scope: sc}
				st.Opts = Options{Scope: sc, Dir: st.Dirs[sc], Desktop: true, OpenWith: true, Source: st.Source}
				logf("older copy %s found in %s", v, st.Dirs[sc])
				break
			}
		}
	}
	return st
}

// checkDir: can the chosen folder be used? (message for the window)
func checkDir(scope, dir string) string {
	d := strings.TrimSpace(dir)
	if d == "" || !filepath.IsAbs(d) {
		return "Enter a full folder path, like C:\\Apps\\PDF Editor."
	}
	if strings.HasPrefix(d, `\\`) {
		return "Install on this PC, not on a network folder."
	}
	if filepath.Dir(filepath.Clean(d)) == filepath.Clean(d) {
		return "Choose a folder, not a whole drive."
	}
	if fileExists(d) && !looksInstalled(d) && olderCopy(d) == "" {
		if entries, err := os.ReadDir(d); err == nil && len(entries) > 0 {
			return "That folder has other files in it. Choose an empty or new one."
		}
	}
	if scope == "user" && !isElevated() && !canWrite(d) {
		return "That folder needs admin rights. Choose another, or install for everyone."
	}
	if scope == "user" && otherAdmin() {
		return "The setup was started with another account's admin rights, so \"Just me\" would install PDF Editor for that account. Choose \"Everyone on this PC\", or start the setup normally (not as administrator)."
	}
	return ""
}

func fatal(msg string) {
	logf("fatal: %s", msg)
	messageBox(msg, mbError)
	os.Exit(1)
}

// orIf: a, or b when a is empty
func orIf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

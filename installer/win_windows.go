//go:build windows

// Windows side of the setup: elevation, processes, shortcuts, registry, folders, message boxes.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const aumid = "pdfeditor.app" // the app's AppUserModelID (app.setAppUserModelId) - taskbar grouping

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	mpr      = windows.NewLazySystemDLL("mpr.dll")
	advapi32 = windows.NewLazySystemDLL("advapi32.dll")

	procMessageBoxW            = user32.NewProc("MessageBoxW")
	procShellExecuteExW        = shell32.NewProc("ShellExecuteExW")
	procSHChangeNotify         = shell32.NewProc("SHChangeNotify")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procCoCreateInstance       = ole32.NewProc("CoCreateInstance")
	procCoInitializeEx         = ole32.NewProc("CoInitializeEx")
	procCoTaskMemFree          = ole32.NewProc("CoTaskMemFree")
	procWNetGetUniversalNameW  = mpr.NewProc("WNetGetUniversalNameW")
	procRegSetValueExW         = advapi32.NewProc("RegSetValueExW")
)

const (
	mbInfo  = 0x40 // MB_ICONINFORMATION
	mbWarn  = 0x30 // MB_ICONWARNING
	mbError = 0x10 // MB_ICONERROR
	mbYesNo = 0x04
	idYes   = 6
)

// noDialogs: automated tests - every question is answered "yes" and only logged
func noDialogs() bool { return os.Getenv("PDFED_SETUP_NO_DIALOGS") == "1" }

func messageBox(text string, flags uint32) int {
	if noDialogs() {
		logf("messagebox: %s", text)
		return idYes
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("PDF Editor Setup")
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags|0x10000 /*MB_SETFOREGROUND*/))
	return int(r)
}

func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

var procWTSQuerySessionInformationW = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

// otherAdmin: this setup runs with the admin rights of another account than the person signed in
// at this desktop (an IT account's name and password typed into Windows' admin prompt). The
// per-user places (profile, Start menu, HKCU) are then that account's, not the person's. Not
// known (no one signed in here - a deployment tool; an error) -> false, as before.
func otherAdmin() bool {
	otherAdminOnce.Do(func() { otherAdminVal = findOtherAdmin() })
	return otherAdminVal
}

var (
	otherAdminOnce sync.Once
	otherAdminVal  bool
)

func findOtherAdmin() bool {
	if !isElevated() {
		return false
	}
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	me, _, _, err := tu.User.Sid.LookupAccount("")
	if err != nil || me == "" {
		return false
	}
	var buf *uint16
	var n uint32
	// WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSUserName
	r, _, _ := procWTSQuerySessionInformationW.Call(0, uintptr(0xFFFFFFFF), 5, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&n)))
	if r == 0 || buf == nil {
		return false
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	desk := windows.UTF16PtrToString(buf)
	if desk == "" {
		return false
	}
	if !strings.EqualFold(desk, me) {
		logf("running as %s, signed in at this desktop: %s", me, desk)
		return true
	}
	return false
}

// exeLocked: PDF Editor from that folder is running. Opening the exe for writing tells (a running
// exe can't be written) - but without admin rights a copy in Program Files always says "access
// denied", so the running programs are looked through as well.
func exeLocked(path string) bool {
	if p, err := windows.UTF16PtrFromString(path); err == nil {
		h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			windows.CloseHandle(h)
		} else if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return true
		}
	}
	return appRunning(path)
}

// appRunning: a process started from exactly this exe (those this user may look at).
func appRunning(exe string) bool {
	mine, _ := appProcs(exe)
	return len(mine) > 0
}

// appProcs: the processes started from exactly this exe ("pid 123 (session 1)"), and those with its
// name this side may not look at (another account's - or, without admin rights, a sandboxed
// Chromium child of our own: the elevated side sees those)
func appProcs(exe string) (mine, unseen []string) {
	want := strings.ToLower(filepath.Clean(exe))
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	base := strings.ToLower(filepath.Base(exe))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if strings.ToLower(windows.UTF16ToString(e.ExeFile[:])) != base || e.ProcessID == uint32(os.Getpid()) {
			continue
		}
		var sess uint32
		_ = windows.ProcessIdToSessionId(e.ProcessID, &sess)
		who := fmt.Sprintf("pid %d (session %d)", e.ProcessID, sess)
		h, err2 := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if err2 != nil {
			unseen = append(unseen, who)
			continue // another user's (the elevated helper sees those - it checks again)
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		n := uint32(len(buf))
		err2 = windows.QueryFullProcessImageName(h, 0, &buf[0], &n)
		windows.CloseHandle(h)
		if err2 == nil && strings.ToLower(filepath.Clean(windows.UTF16ToString(buf[:n]))) == want {
			mine = append(mine, who)
		}
	}
	return mine, unseen
}

// Restart Manager (rstrtmgr.dll): which programs have a file open - for the log only
var (
	rstrtmgr                = windows.NewLazySystemDLL("rstrtmgr.dll")
	procRmStartSession      = rstrtmgr.NewProc("RmStartSession")
	procRmRegisterResources = rstrtmgr.NewProc("RmRegisterResources")
	procRmGetList           = rstrtmgr.NewProc("RmGetList")
	procRmEndSession        = rstrtmgr.NewProc("RmEndSession")
)

type rmUniqueProcess struct {
	ProcessID        uint32
	ProcessStartTime windows.Filetime
}

type rmProcessInfo struct {
	Process          rmUniqueProcess
	AppName          [256]uint16
	ServiceShortName [64]uint16
	ApplicationType  uint32
	AppStatus        uint32
	TSSessionID      uint32
	Restartable      int32
}

// fileHolders: "name (pid 123, session 1)" for each program with the file open; "" if none or
// unknown
func fileHolders(path string) string {
	if procRmStartSession.Find() != nil {
		return ""
	}
	var sess uint32
	key := make([]uint16, 33)
	if r, _, _ := procRmStartSession.Call(uintptr(unsafe.Pointer(&sess)), 0, uintptr(unsafe.Pointer(&key[0]))); r != 0 {
		return ""
	}
	defer procRmEndSession.Call(uintptr(sess))
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	files := []*uint16{p}
	if r, _, _ := procRmRegisterResources.Call(uintptr(sess), 1, uintptr(unsafe.Pointer(&files[0])), 0, 0, 0, 0); r != 0 {
		return ""
	}
	var needed, n, reasons uint32
	var list []rmProcessInfo
	for try := 0; try < 3; try++ {
		n = uint32(len(list))
		var first *rmProcessInfo
		if n > 0 {
			first = &list[0]
		}
		r, _, _ := procRmGetList.Call(uintptr(sess), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(first)), uintptr(unsafe.Pointer(&reasons)))
		if r == 0 {
			break
		}
		if r != 234 { // ERROR_MORE_DATA
			return ""
		}
		list = make([]rmProcessInfo, needed+2)
	}
	var out []string
	for i := 0; i < int(n) && i < len(list); i++ {
		x := list[i]
		name := windows.UTF16ToString(x.AppName[:])
		if svc := windows.UTF16ToString(x.ServiceShortName[:]); svc != "" {
			name += " [service " + svc + "]"
		}
		out = append(out, fmt.Sprintf("%s (pid %d, session %d)", name, x.Process.ProcessID, x.TSSessionID))
	}
	return strings.Join(out, "; ")
}

func waitPid(pid int, d time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return // gone already
	}
	defer windows.CloseHandle(h)
	_, _ = windows.WaitForSingleObject(h, uint32(d/time.Millisecond))
}

func launch(path string, args ...string) error {
	cmd := exec.Command(path, args...)
	cmd.Dir = filepath.Dir(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 /*DETACHED_PROCESS*/ | 0x00000200 /*CREATE_NEW_PROCESS_GROUP*/}
	if err := cmd.Start(); err != nil {
		logf("launch %s: %v", path, err)
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// launchApp starts PDF Editor as the signed-in person even when this program runs with admin
// rights (an app started from an elevated setup would be elevated too: no drag and drop from
// Explorer, files saved as admin). Explorer starts it at the person's normal level.
func launchApp(path string) error {
	if isElevated() {
		if err := exec.Command(filepath.Join(os.Getenv("WINDIR"), "explorer.exe"), path).Start(); err == nil {
			return nil
		}
	}
	return launch(path)
}

func knownFolder(id *windows.KNOWNFOLDERID, fallback string) string {
	if p, err := windows.KnownFolderPath(id, 0); err == nil && p != "" {
		return p
	}
	return fallback
}

func defaultDir(scope string) string {
	if scope == "machine" {
		pf := os.Getenv("ProgramW6432")
		if pf == "" {
			pf = knownFolder(windows.FOLDERID_ProgramFilesX64, `C:\Program Files`)
		}
		return filepath.Join(pf, appName)
	}
	return filepath.Join(knownFolder(windows.FOLDERID_UserProgramFiles, filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")), appName)
}

func userDataDirs() []string {
	return []string{
		filepath.Join(knownFolder(windows.FOLDERID_RoamingAppData, os.Getenv("APPDATA")), appName),
		filepath.Join(knownFolder(windows.FOLDERID_LocalAppData, os.Getenv("LOCALAPPDATA")), appName),
	}
}

// toUNC turns a mapped drive path (Y:\Apps) into \\server\share\Apps; other paths stay.
func toUNC(p string) string {
	if strings.HasPrefix(p, `\\`) || len(p) < 2 || p[1] != ':' {
		return p
	}
	lp, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]byte, 4096)
	size := uint32(len(buf))
	r, _, _ := procWNetGetUniversalNameW.Call(uintptr(unsafe.Pointer(lp)), 1 /*UNIVERSAL_NAME_INFO_LEVEL*/, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return p // a local drive (or not connected): keep it
	}
	ptr := *(**uint16)(unsafe.Pointer(&buf[0]))
	if ptr == nil {
		return p
	}
	if u := windows.UTF16PtrToString(ptr); u != "" {
		return u
	}
	return p
}

// ---------------------------------------------------------------- elevation

type shellExecuteInfo struct {
	cbSize         uint32
	fMask          uint32
	hwnd           uintptr
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       uintptr
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      uintptr
	dwHotKey       uint32
	hIconOrMonitor uintptr
	hProcess       windows.Handle
}

// ownerHwnd: the setup window, so Windows' admin prompt belongs to it
var ownerHwnd uintptr

func shellExecute(verb, file, params string, wait bool) (uint32, error) {
	v, _ := windows.UTF16PtrFromString(verb)
	f, _ := windows.UTF16PtrFromString(file)
	pa, _ := windows.UTF16PtrFromString(params)
	sei := shellExecuteInfo{fMask: 0x00000040 /*SEE_MASK_NOCLOSEPROCESS*/ | 0x00000100 /*SEE_MASK_NOASYNC*/, hwnd: ownerHwnd, lpVerb: v, lpFile: f, lpParameters: pa, nShow: 1}
	sei.cbSize = uint32(unsafe.Sizeof(sei))
	r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&sei)))
	if r == 0 {
		return 0, e
	}
	if sei.hProcess == 0 {
		return 0, nil
	}
	defer windows.CloseHandle(sei.hProcess)
	if !wait {
		return 0, nil
	}
	_, _ = windows.WaitForSingleObject(sei.hProcess, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(sei.hProcess, &code)
	return code, nil
}

func quoteArgs(args ...string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = syscall.EscapeArg(a)
	}
	return strings.Join(q, " ")
}

// runElevated hands the job to a copy of this program started with admin rights (Windows asks
// the person) and follows its progress.
func runElevated(j Job, prog progressFn) error {
	self, _ := os.Executable()
	// (a name made at random by this process, not one to guess - the step with admin rights reads it)
	f, err := os.CreateTemp(os.TempDir(), "pdfed-setup-job-*.json")
	if err != nil {
		return err
	}
	jf := f.Name()
	f.Close()
	if err := writeJSON(jf, j); err != nil {
		_ = os.Remove(jf)
		return err
	}
	defer func() { _ = os.Remove(jf); _ = os.Remove(jf + ".progress"); _ = os.Remove(jf + ".result") }()
	done := make(chan error, 1)
	go func() {
		_, err := shellExecute("runas", self, quoteArgs("--worker", jf), true)
		done <- err
	}()
	for {
		select {
		case err := <-done:
			if err != nil {
				if errors.Is(err, windows.ERROR_CANCELLED) {
					return errors.New("administrator permission was not given")
				}
				return err
			}
			var res jobResult
			if err := readJSON(jf+".result", &res); err != nil {
				return errors.New("the installer with admin rights stopped without finishing")
			}
			if !res.OK {
				if res.Running {
					return errRunning
				}
				return errors.New(res.Err)
			}
			return nil
		case <-time.After(150 * time.Millisecond):
			if b, err := os.ReadFile(jf + ".progress"); err == nil {
				if parts := strings.SplitN(string(b), "|", 2); len(parts) == 2 {
					if f, err := strconv.ParseFloat(parts[0], 64); err == nil {
						prog(f, parts[1])
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------- COM (shortcuts, folder picker)

func comCall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	clsidShellLink      = mustGUID("{00021401-0000-0000-C000-000000000046}")
	iidShellLinkW       = mustGUID("{000214F9-0000-0000-C000-000000000046}")
	iidPersistFile      = mustGUID("{0000010b-0000-0000-C000-000000000046}")
	iidPropertyStore    = mustGUID("{886d8eeb-8cf2-4446-8d02-cdba1dbdcf99}")
	pkeyAppUserModelID  = mustGUID("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}")
	clsidFileOpenDialog = mustGUID("{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}")
	iidFileOpenDialog   = mustGUID("{d57c7288-d4ad-4768-be02-9d969532d960}")
	iidShellItem        = mustGUID("{43826d1e-e718-42ee-bc55-a1e261c37bfe}")
)

func coCreate(clsid, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(clsid)), 0, 1 /*CLSCTX_INPROC_SERVER*/, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("CoCreateInstance failed: %08x", uint32(hr))
	}
	return p, nil
}

func comQI(obj uintptr, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr := comCall(obj, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("QueryInterface failed: %08x", uint32(hr))
	}
	return p, nil
}

// withCOM runs f on a locked thread with COM ready (shortcut creation from a worker goroutine).
func withCOM(f func() error) error {
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procCoInitializeEx.Call(0, 2 /*COINIT_APARTMENTTHREADED*/)
		ch <- f()
	}()
	return <-ch
}

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

type propVariant struct {
	vt       uint16
	r1, r2   uint16
	r3       uint16
	val      uintptr
	reserved uintptr
}

func u16(s string) uintptr {
	p, _ := windows.UTF16PtrFromString(s)
	return uintptr(unsafe.Pointer(p))
}

func makeShortcut(lnk, target, workdir, icon, desc string) error {
	sl, err := coCreate(&clsidShellLink, &iidShellLinkW)
	if err != nil {
		return err
	}
	defer comRelease(sl)
	strs := []string{target, workdir, desc, icon, lnk, aumid}
	keep := make([]*uint16, len(strs))
	for i, s := range strs {
		keep[i], _ = windows.UTF16PtrFromString(s)
	}
	comCall(sl, 20, uintptr(unsafe.Pointer(keep[0]))) // SetPath
	comCall(sl, 9, uintptr(unsafe.Pointer(keep[1])))  // SetWorkingDirectory
	comCall(sl, 7, uintptr(unsafe.Pointer(keep[2])))  // SetDescription
	comCall(sl, 17, uintptr(unsafe.Pointer(keep[3])), 0) // SetIconLocation
	if ps, err := comQI(sl, &iidPropertyStore); err == nil {
		key := propertyKey{fmtid: pkeyAppUserModelID, pid: 5}
		pv := propVariant{vt: 31 /*VT_LPWSTR*/, val: uintptr(unsafe.Pointer(keep[5]))}
		comCall(ps, 6, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv))) // SetValue
		comCall(ps, 7)                                                             // Commit
		comRelease(ps)
	}
	pf, err := comQI(sl, &iidPersistFile)
	if err != nil {
		return err
	}
	defer comRelease(pf)
	_ = os.MkdirAll(filepath.Dir(lnk), 0o755)
	if hr := comCall(pf, 6, uintptr(unsafe.Pointer(keep[4])), 1); int32(hr) < 0 { // Save
		return fmt.Errorf("saving %s failed: %08x", lnk, uint32(hr))
	}
	runtime.KeepAlive(keep)
	return nil
}

func shortcutPaths(scope string) (start, desktop string) {
	if scope == "machine" {
		return filepath.Join(knownFolder(windows.FOLDERID_CommonPrograms, filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs`)), appName+".lnk"),
			filepath.Join(knownFolder(windows.FOLDERID_PublicDesktop, filepath.Join(os.Getenv("PUBLIC"), "Desktop")), appName+".lnk")
	}
	return filepath.Join(knownFolder(windows.FOLDERID_Programs, filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)), appName+".lnk"),
		filepath.Join(knownFolder(windows.FOLDERID_Desktop, filepath.Join(os.Getenv("USERPROFILE"), "Desktop")), appName+".lnk")
}

func makeShortcuts(dir string, ii InstallInfo) error {
	exe := filepath.Join(dir, exeName)
	start, desktop := shortcutPaths(ii.Scope)
	return withCOM(func() error {
		var first error
		if err := makeShortcut(start, exe, dir, exe, "View, mark up, measure and edit PDFs"); err != nil {
			first = err
		}
		if ii.Desktop {
			if err := makeShortcut(desktop, exe, dir, exe, "View, mark up, measure and edit PDFs"); err != nil && first == nil {
				first = err
			}
		} else {
			_ = os.Remove(desktop)
		}
		return first
	})
}

func removeShortcuts(scope, dir string) {
	// (made together with the uninstall entry: another copy's are left alone)
	if !ownsEntries(rootFor(scope), dir) {
		logf("shortcuts and the uninstall entry belong to %s - left as they are", getStr(rootFor(scope), uninstallKey, "InstallLocation"))
		return
	}
	start, desktop := shortcutPaths(scope)
	_ = os.Remove(start)
	_ = os.Remove(desktop)
}

// pickFolder: the standard Windows folder picker. "" when cancelled.
func pickFolder(owner uintptr, title, start string) string {
	d, err := coCreate(&clsidFileOpenDialog, &iidFileOpenDialog)
	if err != nil {
		logf("folder picker: %v", err)
		return ""
	}
	defer comRelease(d)
	var opts uint32
	comCall(d, 10, uintptr(unsafe.Pointer(&opts)))                           // GetOptions
	comCall(d, 9, uintptr(opts|0x20 /*PICKFOLDERS*/|0x40 /*FORCEFILESYSTEM*/)) // SetOptions
	t, _ := windows.UTF16PtrFromString(title)
	comCall(d, 17, uintptr(unsafe.Pointer(t))) // SetTitle
	if start != "" {
		for p := start; p != "" && p != filepath.Dir(p); p = filepath.Dir(p) {
			if fileExists(p) {
				sp, _ := windows.UTF16PtrFromString(p)
				var item uintptr
				hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(sp)), 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)))
				if int32(hr) >= 0 && item != 0 {
					comCall(d, 12, item) // SetFolder
					comRelease(item)
				}
				break
			}
		}
	}
	if hr := comCall(d, 3, owner); int32(hr) < 0 { // Show (cancelled: 0x800704C7)
		return ""
	}
	var item uintptr
	if hr := comCall(d, 20, uintptr(unsafe.Pointer(&item))); int32(hr) < 0 || item == 0 { // GetResult
		return ""
	}
	defer comRelease(item)
	var name *uint16
	if hr := comCall(item, 5, 0x80058000 /*SIGDN_FILESYSPATH*/, uintptr(unsafe.Pointer(&name))); int32(hr) < 0 || name == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
	return windows.UTF16PtrToString(name)
}

// ---------------------------------------------------------------- registry

const (
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\PDFEditor`
	appPathsKey  = `Software\Microsoft\Windows\CurrentVersion\App Paths\PDF Editor.exe`
	progID       = "PDFEditor.Document"
	capsKey      = `Software\PDF Editor\Capabilities`
	combineKey   = `\SystemFileAssociations\.pdf\shell\PDFEditor.Combine`
)

func rootFor(scope string) registry.Key {
	if scope == "machine" {
		return registry.LOCAL_MACHINE
	}
	return registry.CURRENT_USER
}

func setStr(root registry.Key, path, name, val string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, val)
}

func setDword(root registry.Key, path, name string, val uint32) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, val)
}

// setNone writes an empty REG_NONE value (how Windows lists "Open with" programs).
func setNone(root registry.Key, path, name string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	n, _ := windows.UTF16PtrFromString(name)
	r, _, _ := procRegSetValueExW.Call(uintptr(k), uintptr(unsafe.Pointer(n)), 0, 0 /*REG_NONE*/, 0, 0)
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

func deleteTree(root registry.Key, path string) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS|registry.WOW64_64KEY)
	if err == nil {
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, s := range subs {
			deleteTree(root, path+`\`+s)
		}
	}
	_ = registry.DeleteKey(root, path)
}

func deleteValue(root registry.Key, path, name string) {
	k, err := registry.OpenKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err == nil {
		_ = k.DeleteValue(name)
		k.Close()
	}
}

func getStr(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue(name)
	return v
}

func registerApp(dir string, ii InstallInfo) error {
	root := rootFor(ii.Scope)
	exe := filepath.Join(dir, exeName)
	setup := filepath.Join(dir, setupName)
	icon := `"` + exe + `",0`
	fileIcon := filepath.Join(dir, `resources\app\dist\pdf-file.ico`)
	if fileExists(fileIcon) {
		icon = `"` + fileIcon + `",0`
	}
	var errs []string
	add := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	// Installed apps (Settings > Apps) with a working Uninstall button
	add(setStr(root, uninstallKey, "DisplayName", appName))
	add(setStr(root, uninstallKey, "DisplayVersion", ii.Version))
	add(setStr(root, uninstallKey, "DisplayIcon", `"`+exe+`",0`))
	add(setStr(root, uninstallKey, "InstallLocation", dir))
	add(setStr(root, uninstallKey, "UninstallString", `"`+setup+`" --uninstall`))
	add(setStr(root, uninstallKey, "QuietUninstallString", `"`+setup+`" --uninstall --silent`))
	add(setStr(root, uninstallKey, "InstallDate", time.Now().Format("20060102")))
	add(setDword(root, uninstallKey, "NoModify", 1))
	add(setDword(root, uninstallKey, "NoRepair", 1))
	add(setDword(root, uninstallKey, "EstimatedSize", dirSizeKB(dir)))
	// "PDF Editor" works in the Run box
	add(setStr(root, appPathsKey, "", exe))
	add(setStr(root, appPathsKey, "Path", dir))
	classes := `Software\Classes`
	if ii.OpenWith {
		add(setStr(root, classes+`\`+progID, "", "PDF document"))
		add(setStr(root, classes+`\`+progID+`\DefaultIcon`, "", icon))
		add(setStr(root, classes+`\`+progID+`\shell\open\command`, "", `"`+exe+`" "%1"`))
		add(setNone(root, classes+`\.pdf\OpenWithProgids`, progID))
		add(setStr(root, classes+`\Applications\PDF Editor.exe`, "FriendlyAppName", appName))
		add(setStr(root, classes+`\Applications\PDF Editor.exe\DefaultIcon`, "", icon))
		add(setStr(root, classes+`\Applications\PDF Editor.exe\SupportedTypes`, ".pdf", ""))
		add(setStr(root, classes+`\Applications\PDF Editor.exe\shell\open\command`, "", `"`+exe+`" "%1"`))
		// listed in Settings > Default apps
		add(setStr(root, capsKey, "ApplicationName", appName))
		add(setStr(root, capsKey, "ApplicationDescription", "View, mark up, measure and edit PDFs"))
		add(setStr(root, capsKey, "ApplicationIcon", `"`+exe+`",0`))
		add(setStr(root, capsKey+`\FileAssociations`, ".pdf", progID))
		add(setStr(root, `Software\RegisteredApplications`, appName, capsKey))
	} else {
		removeAssociation(root, dir)
	}
	// Explorer: select PDFs > right-click > "Combine with PDF Editor" (Windows 11: under Show more
	// options). Player: offered for any number of files (Windows hides it above 15 otherwise);
	// Windows starts the app once per file and the running copy collects them.
	add(setStr(root, classes+combineKey, "", "Combine with PDF Editor"))
	add(setStr(root, classes+combineKey, "Icon", `"`+exe+`",0`))
	add(setStr(root, classes+combineKey, "MultiSelectModel", "Player"))
	add(setStr(root, classes+combineKey+`\command`, "", `"`+exe+`" --combine "%1"`))
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// removeAssociation only removes entries that point at this install (a portable copy may have
// registered itself).
func removeAssociation(root registry.Key, dir string) {
	removeOpenWith(root, dir)
	deleteValue(root, `Software\RegisteredApplications`, appName)
	deleteTree(root, `Software\PDF Editor`)
}

// removeOpenWith: the "Open with" entries, only when they start this install's exe.
func removeOpenWith(root registry.Key, dir string) {
	classes := `Software\Classes`
	cmd := strings.ToLower(getStr(root, classes+`\`+progID+`\shell\open\command`, ""))
	if cmd == "" || strings.Contains(cmd, strings.ToLower(dir)) {
		deleteTree(root, classes+`\`+progID)
		deleteValue(root, classes+`\.pdf\OpenWithProgids`, progID)
	}
	cmd = strings.ToLower(getStr(root, classes+`\Applications\PDF Editor.exe\shell\open\command`, ""))
	if cmd == "" || strings.Contains(cmd, strings.ToLower(dir)) {
		deleteTree(root, classes+`\Applications\PDF Editor.exe`)
	}
}

// ownsEntries: the uninstall entry (and the shortcuts made with it) are this install's - or there
// is none. Uninstalling a second copy (copied by hand, or installed again elsewhere) leaves the
// other one's Settings > Apps entry, shortcuts and Default apps entry alone.
func ownsEntries(root registry.Key, dir string) bool {
	loc := getStr(root, uninstallKey, "InstallLocation")
	return loc == "" || strings.EqualFold(filepath.Clean(loc), filepath.Clean(dir))
}

// removeCombine: only when it points at this install
func removeCombine(root registry.Key, dir string) {
	classes := `Software\Classes`
	cmd := strings.ToLower(getStr(root, classes+combineKey+`\command`, ""))
	if cmd == "" || strings.Contains(cmd, strings.ToLower(dir)) {
		deleteTree(root, classes+combineKey)
	}
}

func unregisterApp(dir, scope string) {
	root := rootFor(scope)
	own := ownsEntries(root, dir)
	if own {
		deleteTree(root, uninstallKey)
	}
	removeCombine(root, dir)
	if root != registry.CURRENT_USER {
		// the app adds these for the person too (HKCU): Combine after an update that came without
		// the setup, and "Add to Windows Open with" in its settings - also in a copy for everyone
		removeCombine(registry.CURRENT_USER, dir)
		removeOpenWith(registry.CURRENT_USER, dir)
	}
	if strings.EqualFold(getStr(root, appPathsKey, ""), filepath.Join(dir, exeName)) {
		deleteTree(root, appPathsKey)
	}
	if own {
		removeAssociation(root, dir)
	} else {
		removeOpenWith(root, dir)
	}
}

func setRegistryVersion(dir, v string) {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		if strings.EqualFold(filepath.Clean(getStr(root, uninstallKey, "InstallLocation")), filepath.Clean(dir)) {
			_ = setStr(root, uninstallKey, "DisplayVersion", v)
		}
	}
}

// findInstalled: an existing install (this user's first, then for everyone).
func findInstalled() (string, *InstallInfo) {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		dir := getStr(root, uninstallKey, "InstallLocation")
		if dir == "" || !looksInstalled(dir) {
			continue
		}
		ii, err := readInstall(dir)
		if err != nil {
			continue
		}
		return dir, ii
	}
	return "", nil
}

func notifyAssocChanged() {
	procSHChangeNotify.Call(0x08000000 /*SHCNE_ASSOCCHANGED*/, 0, 0, 0)
}

// openDefaultApps: Windows' own page for choosing PDF Editor for PDFs (apps can't set
// themselves as the default since Windows 10).
func openDefaultApps(scope string) {
	q := "registeredAppUser"
	if scope == "machine" {
		q = "registeredAppMachine"
	}
	_, _ = shellExecute("open", "ms-settings:defaultapps?"+q+"=PDF%20Editor", "", false)
}

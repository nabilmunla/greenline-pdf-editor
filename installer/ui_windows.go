//go:build windows

// The setup window: a small borderless window holding a WebView2 page (Edge's engine, part of
// Windows 10/11) styled like the app. Without WebView2 the setup falls back to plain prompts.
package main

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

//go:embed ui.html
var uiHTML string

var (
	kernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	dwmapi                    = windows.NewLazySystemDLL("dwmapi.dll")
	procGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	procCreateMutexW          = kernel32.NewProc("CreateMutexW")
	procRegisterClassExW      = user32.NewProc("RegisterClassExW")
	procCreateWindowExW       = user32.NewProc("CreateWindowExW")
	procDefWindowProcW        = user32.NewProc("DefWindowProcW")
	procDestroyWindow         = user32.NewProc("DestroyWindow")
	procShowWindow            = user32.NewProc("ShowWindow")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	procGetMessageW           = user32.NewProc("GetMessageW")
	procTranslateMessage      = user32.NewProc("TranslateMessage")
	procDispatchMessageW      = user32.NewProc("DispatchMessageW")
	procPostMessageW          = user32.NewProc("PostMessageW")
	procPostQuitMessage       = user32.NewProc("PostQuitMessage")
	procReleaseCapture        = user32.NewProc("ReleaseCapture")
	procLoadIconW             = user32.NewProc("LoadIconW")
	procLoadImageW            = user32.NewProc("LoadImageW")
	procSetWindowPos          = user32.NewProc("SetWindowPos")
	procGetDpiForSystem       = user32.NewProc("GetDpiForSystem")
	procGetDpiForWindow       = user32.NewProc("GetDpiForWindow")
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
	procFindWindowW           = user32.NewProc("FindWindowW")
	procIsIconic              = user32.NewProc("IsIconic")
	procGetKeyState           = user32.NewProc("GetKeyState")
	procSendMessageW          = user32.NewProc("SendMessageW")
	procCreateSolidBrush      = windows.NewLazySystemDLL("gdi32.dll").NewProc("CreateSolidBrush")
	procDwmExtendFrame        = dwmapi.NewProc("DwmExtendFrameIntoClientArea")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	wmDestroy     = 0x0002
	wmSize        = 0x0005
	wmClose       = 0x0010
	wmNcCalcSize  = 0x0083
	wmNcActivate  = 0x0086
	wmNcLButtonDn = 0x00A1
	wmSetIcon     = 0x0080
	wmDpiChanged  = 0x02E0
	wmMove        = 0x0003
	wmDispatch    = 0x8001
	className     = "PDFEditorSetupWindow"
	uiW, uiH      = 600, 440
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}

type rect struct{ left, top, right, bottom int32 }

type ui struct {
	hwnd    uintptr
	wv      *edge.Chromium
	mu      sync.Mutex
	queue   []func()
	busy    atomic.Bool
	shown   bool
	state   UIState
	p       *Payload
	ok      bool
	dir     string // the install folder (after install / for uninstall)
	scope   string
	dataDir string
	started bool // the page has asked for its data (it runs)
	broken  bool // it never did: the window goes, plain prompts instead
}

var theUI *ui

func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString("Local\\PDFEditorSetupWindow")
	procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if windows.GetLastError() == windows.ERROR_ALREADY_EXISTS {
		cn, _ := windows.UTF16PtrFromString(className)
		if h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cn)), 0); h != 0 {
			if r, _, _ := procIsIconic.Call(h); r != 0 {
				procShowWindow.Call(h, 9) // SW_RESTORE
			}
			procSetForegroundWindow.Call(h)
		}
		return false
	}
	return true
}

func webview2Available() bool {
	v, err := webviewloader.GetInstalledVersion()
	logf("WebView2 runtime: %q %v", v, err)
	return err == nil && v != ""
}

func installUI(p *Payload, st UIState) int {
	if !singleInstance() {
		return 0
	}
	if plainUI || !webview2Available() {
		return fallbackInstall(p, st)
	}
	u := &ui{state: st, p: p, dir: st.Opts.Dir, scope: st.Opts.Scope}
	if !u.run() {
		return fallbackInstall(p, st)
	}
	if u.ok {
		return 0
	}
	return 1
}

func uninstallUI(dir, scope string) int {
	if !singleInstance() {
		return 0
	}
	ver := ""
	if ii, err := readInstall(dir); err == nil {
		ver = ii.Version
	}
	st := UIState{Mode: "uninstall", Version: ver, Existing: &Existing{Version: ver, Dir: dir, Scope: scope}}
	if plainUI || !webview2Available() {
		return fallbackUninstall(dir, scope)
	}
	u := &ui{state: st, dir: dir, scope: scope}
	if !u.run() {
		return fallbackUninstall(dir, scope)
	}
	if u.ok {
		return 0
	}
	return 1
}

// run shows the window until it's closed. false = the web view couldn't start (use prompts).
func (u *ui) run() bool {
	theUI = u
	u.dataDir = filepath.Join(os.TempDir(), "PDF Editor Setup WebView")
	hinst, _, _ := procGetModuleHandleW.Call(0)
	cn, _ := windows.UTF16PtrFromString(className)
	icon, _, _ := procLoadIconW.Call(hinst, 1)
	iconSm, _, _ := procLoadImageW.Call(hinst, 1, 1 /*IMAGE_ICON*/, 16, 16, 0)
	brush, _, _ := procCreateSolidBrush.Call(0x002F3009) // #09302f
	wc := wndClassEx{style: 0x0003, lpfnWndProc: syscall.NewCallback(wndProc), hInstance: hinst, hIcon: icon, hbrBackground: brush, lpszClassName: cn, hIconSm: iconSm}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	dpi := uint32(96)
	if procGetDpiForSystem.Find() == nil {
		if d, _, _ := procGetDpiForSystem.Call(); d > 0 {
			dpi = uint32(d)
		}
	}
	w, h := int32(uiW*dpi/96), int32(uiH*dpi/96)
	var wa rect
	procSystemParametersInfoW.Call(0x0030 /*SPI_GETWORKAREA*/, 0, uintptr(unsafe.Pointer(&wa)), 0)
	x, y := wa.left+(wa.right-wa.left-w)/2, wa.top+(wa.bottom-wa.top-h)/2
	title, _ := windows.UTF16PtrFromString(displayName + " Setup")
	const style = 0x80000000 /*POPUP*/ | 0x00C00000 /*CAPTION*/ | 0x00080000 /*SYSMENU*/ | 0x00020000 /*MINIMIZEBOX*/
	hwnd, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(cn)), uintptr(unsafe.Pointer(title)), style, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0, 0, hinst, 0)
	if hwnd == 0 {
		logf("CreateWindowEx failed")
		return false
	}
	u.hwnd = hwnd
	ownerHwnd = hwnd
	procSendMessageW.Call(hwnd, wmSetIcon, 1, icon)
	procSendMessageW.Call(hwnd, wmSetIcon, 0, iconSm)
	// a shadow and (Windows 11) round corners without the standard title bar
	margins := [4]int32{0, 0, 1, 0}
	procDwmExtendFrame.Call(hwnd, uintptr(unsafe.Pointer(&margins)))
	round := uint32(2) // DWMWCP_ROUND
	procDwmSetWindowAttribute.Call(hwnd, 33, uintptr(unsafe.Pointer(&round)), 4)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, 0x0001|0x0002|0x0004|0x0020) // NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED

	u.wv = edge.NewChromium()
	u.wv.DataPath = u.dataDir
	u.wv.MessageCallback = u.onMessage
	u.wv.AcceleratorKeyCallback = func(vk uint) bool {
		ctrl, _, _ := procGetKeyState.Call(0x11)
		if int16(ctrl) < 0 {
			switch vk {
			case 'R', 'P', 'F', 'U', 'G', 'J', 'H', 'S', 'O', 'N', 'W', 0xBB, 0xBD, 0x6B, 0x6D, '0':
				return true // reload, print, find, zoom... not in a setup window
			}
		}
		switch vk {
		case 0x74, 0x76, 0x7A, 0x7B: // F5 F7 F11 F12
			return true
		}
		return false
	}
	// WebView2 that never answers (broken install, blocked by policy): plain prompts after 25 s
	watchdog := time.AfterFunc(25*time.Second, func() { logf("WebView2 didn't answer in time"); u.wv.Abort() })
	ok := u.wv.Embed(hwnd)
	watchdog.Stop()
	if !ok {
		logf("WebView2 didn't start")
		procDestroyWindow.Call(hwnd)
		return false
	}
	if s, err := u.wv.GetSettings(); err == nil {
		_ = s.PutAreDefaultContextMenusEnabled(false)
		_ = s.PutAreDevToolsEnabled(false)
		_ = s.PutIsStatusBarEnabled(false)
		_ = s.PutIsZoomControlEnabled(false)
		_ = s.PutAreDefaultScriptDialogsEnabled(false)
	}
	if c := u.wv.GetController(); c != nil {
		if c2 := c.GetICoreWebView2Controller2(); c2 != nil {
			_ = c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{A: 255, R: 9, G: 48, B: 47})
		}
	}
	u.wv.NavigationCompletedCallback = func(_ *edge.ICoreWebView2, args *edge.ICoreWebView2NavigationCompletedEventArgs) {
		ok, status := navResult(args)
		logf("page loaded: success=%v status=%d", ok, status)
	}
	u.wv.Resize()
	// the page as a file next to the web view's data (a real address): NavigateToString was the
	// first suspect when the window stayed empty on a PC with WebView2 155 - kept as the fallback
	page := filepath.Join(u.dataDir, "setup.html")
	if err := os.WriteFile(page, []byte(uiHTML), 0o644); err == nil {
		addr := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(page)}).String()
		u.wv.Navigate(addr)
		logf("page opened from %s", addr)
	} else {
		u.wv.NavigateToString(uiHTML)
		logf("page sent as text (%d bytes; file: %v)", len(uiHTML), err)
	}
	// shown when the page says it's ready (no white flash) - or a moment after it started, in
	// case "ready" gets lost. A page that never starts at all (WebView2 broken by a policy, an
	// antivirus or a graphics driver) must not leave an empty window: it is closed and the plain
	// Windows prompts take over.
	time.AfterFunc(4*time.Second, func() {
		u.dispatch(func() {
			if u.started {
				u.show()
			}
		})
	})
	time.AfterFunc(9*time.Second, func() {
		u.dispatch(func() {
			if u.started || u.hwnd == 0 {
				return
			}
			logf("the page never started: plain prompts instead")
			u.broken = true
			ownerHwnd = 0
			procDestroyWindow.Call(u.hwnd)
		})
	})

	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	// the web view's own files in TEMP: removed before the setup ends (the window's helper processes
	// let go of them a moment after it closed - a goroutine waiting for that never ran: the setup
	// exits first). With plain prompts to follow, that happens meanwhile.
	if u.broken {
		go func() { time.Sleep(1500 * time.Millisecond); _ = os.RemoveAll(u.dataDir) }()
		time.Sleep(200 * time.Millisecond)
	} else if err := retry(4*time.Second, func() error { return os.RemoveAll(u.dataDir) }); err != nil {
		logf("web view files left in %s: %v", u.dataDir, err)
	}
	return !u.broken
}

// navResult reads a finished navigation's outcome (IsSuccess, WebErrorStatus) for the log.
func navResult(a *edge.ICoreWebView2NavigationCompletedEventArgs) (bool, int32) {
	if a == nil {
		return false, -1
	}
	v := *(**[5]uintptr)(unsafe.Pointer(a)) // IUnknown (3) + GetIsSuccess + GetWebErrorStatus
	var ok int32
	var st int32
	syscall.SyscallN(v[3], uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(&ok)))
	syscall.SyscallN(v[4], uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(&st)))
	return ok != 0, st
}

func (u *ui) show() {
	if u.shown || u.hwnd == 0 {
		return
	}
	u.shown = true
	procShowWindow.Call(u.hwnd, 5) // SW_SHOW
	// (the web view was made while the window was hidden: told again where and that it shows)
	u.wv.Resize()
	_ = u.wv.Show()
	_ = u.wv.NotifyParentWindowPositionChanged()
	procSetForegroundWindow.Call(u.hwnd)
	u.wv.Focus()
}

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	u := theUI
	switch msg {
	case wmNcCalcSize:
		if wp != 0 {
			return 0 // the whole window is the page
		}
	case wmNcActivate:
		r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, ^uintptr(0)) // don't repaint a title bar
		return r
	case wmSize:
		if u != nil && u.wv != nil {
			u.wv.Resize()
		}
		return 0
	case wmMove:
		if u != nil && u.wv != nil {
			_ = u.wv.NotifyParentWindowPositionChanged()
		}
	case wmDpiChanged:
		r := (*rect)(unsafe.Pointer(lp))
		procSetWindowPos.Call(hwnd, 0, uintptr(r.left), uintptr(r.top), uintptr(r.right-r.left), uintptr(r.bottom-r.top), 0x0004|0x0010)
		return 0
	case wmDispatch:
		if u != nil {
			u.mu.Lock()
			q := u.queue
			u.queue = nil
			u.mu.Unlock()
			for _, f := range q {
				f()
			}
		}
		return 0
	case wmClose:
		if u != nil && u.busy.Load() {
			return 0 // not in the middle of installing
		}
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

func (u *ui) dispatch(f func()) {
	u.mu.Lock()
	u.queue = append(u.queue, f)
	u.mu.Unlock()
	procPostMessageW.Call(u.hwnd, wmDispatch, 0, 0)
}

func jsJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

func (u *ui) reply(id int, v any) {
	u.wv.Eval("window.__r(" + jsJSON(id) + "," + jsJSON(v) + ")")
}

func (u *ui) emit(name string, v any) {
	u.wv.Eval("window.__ev(" + jsJSON(name) + "," + jsJSON(v) + ")")
}

func (u *ui) progress(pct float64, stage string) {
	u.dispatch(func() { u.emit("progress", map[string]any{"pct": pct, "stage": stage}) })
}

type rpc struct {
	ID int               `json:"id"`
	M  string            `json:"m"`
	A  []json.RawMessage `json:"a"`
}

func (r rpc) str(i int) string {
	var s string
	if i < len(r.A) {
		_ = json.Unmarshal(r.A[i], &s)
	}
	return s
}

func (r rpc) boolean(i int) bool {
	var b bool
	if i < len(r.A) {
		_ = json.Unmarshal(r.A[i], &b)
	}
	return b
}

// onMessage: calls from the page (on the window's thread).
func (u *ui) onMessage(msg string) {
	var r rpc
	if err := json.Unmarshal([]byte(msg), &r); err != nil {
		return
	}
	switch r.M {
	case "init":
		if !u.started {
			logf("page started")
		}
		u.started = true
		u.reply(r.ID, u.state)
	case "ready":
		u.dispatch(u.show)
		u.reply(r.ID, true)
	case "drag":
		procReleaseCapture.Call()
		procPostMessageW.Call(u.hwnd, wmNcLButtonDn, 2 /*HTCAPTION*/, 0)
	case "min":
		procShowWindow.Call(u.hwnd, 6) // SW_MINIMIZE
	case "close":
		procPostMessageW.Call(u.hwnd, wmClose, 0, 0)
	case "log":
		logf("page: %s", r.str(0))
	case "check":
		u.reply(r.ID, checkDir(r.str(0), r.str(1)))
	case "browse":
		kind, cur := r.str(0), r.str(1)
		u.dispatch(func() {
			title := "Choose where to install " + displayName
			if kind == "source" {
				title = "Choose the folder where new versions are published"
			}
			p := pickFolder(u.hwnd, title, cur)
			if p != "" && kind == "dir" && !looksInstalled(p) && !strings.EqualFold(filepath.Base(p), appName) {
				p = filepath.Join(p, appName)
			}
			if p != "" && kind == "source" {
				p = toUNC(p)
			}
			u.reply(r.ID, p)
		})
	case "install":
		var o Options
		if len(r.A) > 0 {
			_ = json.Unmarshal(r.A[0], &o)
		}
		if o.Dir == "" {
			o.Dir = defaultDir(o.Scope)
		}
		if msg := checkDir(o.Scope, o.Dir); msg != "" {
			u.emit("done", map[string]any{"ok": false, "err": msg})
			return
		}
		u.busy.Store(true)
		u.reply(r.ID, true)
		go func() {
			err := runAs(u.p, Job{Kind: "install", Opts: o}, needsElevation(o.Dir, o.Scope), u.progress)
			u.dispatch(func() {
				u.busy.Store(false)
				res := map[string]any{"ok": err == nil}
				if err != nil {
					res["err"] = err.Error()
					res["running"] = err == errRunning
					logf("install failed: %v", err)
				} else {
					u.ok, u.dir, u.scope = true, filepath.Clean(o.Dir), o.Scope
				}
				u.emit("done", res)
			})
		}()
	case "uninstall":
		removeData := r.boolean(0)
		u.busy.Store(true)
		u.reply(r.ID, true)
		go func() {
			err := runAs(nil, Job{Kind: "uninstall", Dir: u.dir}, needsElevation(u.dir, u.scope), u.progress)
			if err == nil && removeData {
				removeUserData()
			}
			u.dispatch(func() {
				u.busy.Store(false)
				res := map[string]any{"ok": err == nil}
				if err != nil {
					res["err"] = err.Error()
					res["running"] = err == errRunning
				} else {
					u.ok = true
				}
				u.emit("done", res)
			})
		}()
	case "open":
		_ = launchApp(filepath.Join(u.dir, exeName))
		procPostMessageW.Call(u.hwnd, wmClose, 0, 0)
	case "defaults":
		openDefaultApps(u.scope)
	}
}

// ---------------------------------------------------------------- without WebView2: prompts

func fallbackInstall(p *Payload, st UIState) int {
	o := st.Opts
	what := "Install " + displayName + " " + st.Version + " for you (no admin rights needed)?\n\nFolder: " + o.Dir
	if st.Existing != nil {
		what = "Update " + displayName + " " + st.Existing.Version + " to " + st.Version + "?\nYour settings stay.\n\nFolder: " + o.Dir
	}
	if messageBox(what, mbYesNo|mbInfo) != idYes {
		return 1
	}
	for {
		err := runAs(p, Job{Kind: "install", Opts: o}, needsElevation(o.Dir, o.Scope), func(float64, string) {})
		if err == errRunning {
			// (no one to answer - an automated run - would mean asking for ever: it stops)
			if !noDialogs() && messageBox(displayName+" is open. Close it, then press Yes to continue.", mbYesNo|mbWarn) == idYes {
				continue
			}
			logf("install: PDF Editor is open")
			return 1
		}
		if err != nil {
			messageBox(displayName+" couldn't be installed:\n\n"+err.Error(), mbError)
			return 1
		}
		break
	}
	if messageBox(displayName+" is installed. Open it now?", mbYesNo|mbInfo) == idYes {
		_ = launchApp(filepath.Join(o.Dir, exeName))
	}
	return 0
}

func fallbackUninstall(dir, scope string) int {
	if messageBox("Remove "+displayName+" from this PC?\n\n"+dir, mbYesNo|mbWarn) != idYes {
		return 1
	}
	removeData := messageBox("Also remove your "+displayName+" settings, recent files list, saved AI keys, backups of saved files and copies of unsaved work?", mbYesNo|mbInfo) == idYes
	for {
		err := runAs(nil, Job{Kind: "uninstall", Dir: dir}, needsElevation(dir, scope), func(float64, string) {})
		if err == errRunning {
			if !noDialogs() && messageBox(displayName+" is open. Close it, then press Yes to continue.", mbYesNo|mbWarn) == idYes {
				continue
			}
			logf("uninstall: PDF Editor is open")
			return 1
		}
		if err != nil {
			messageBox(displayName+" couldn't be removed completely:\n\n"+err.Error(), mbError)
			return 1
		}
		break
	}
	if removeData {
		removeUserData()
	}
	messageBox(displayName+" has been removed.", mbInfo)
	return 0
}

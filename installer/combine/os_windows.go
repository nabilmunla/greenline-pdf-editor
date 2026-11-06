package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	user32                         = syscall.NewLazyDLL("user32.dll")
	procGetExitCodeProcess         = kernel32.NewProc("GetExitCodeProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procAllowSetForegroundWindow   = user32.NewProc("AllowSetForegroundWindow")
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// alive: the process is still running and is PDF Editor or this program (a process number can be
// used again by something else - or by another account's process, which can't be opened: not ours)
func alive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if r, _, _ := procGetExitCodeProcess.Call(uintptr(h), uintptr(unsafe.Pointer(&code))); r == 0 || code != stillActive {
		return false
	}
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	if r, _, _ := procQueryFullProcessImageNameW.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return true // (running; its name couldn't be read)
	}
	return ours(syscall.UTF16ToString(buf[:n]))
}

// allowForeground: Explorer started this program from a click, so it may bring a window to the
// front - passed on, so the PDF Editor window comes forward rather than blinking in the taskbar
func allowForeground() {
	procAllowSetForegroundWindow.Call(uintptr(0xFFFFFFFF)) // ASFW_ANY
}

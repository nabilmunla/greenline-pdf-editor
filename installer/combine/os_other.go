//go:build !windows

package main

import "syscall"

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func allowForeground() {}

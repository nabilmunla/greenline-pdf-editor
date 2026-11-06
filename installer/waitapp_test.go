package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 0.8.7: the update helper waits for the app's last processes instead of looking once
func TestWaitAppGone(t *testing.T) {
	logPath = filepath.Join(t.TempDir(), "setup.log")
	defer func() { appProcsFn = appProcs }()
	n := 0
	appProcsFn = func(string) ([]string, []string) {
		n++
		if n <= 3 {
			return []string{"pid 42 (session 1)"}, []string{"pid 7 (session 0)"}
		}
		return nil, nil
	}
	if !waitAppGone(`C:\Program Files\PDF Editor\PDF Editor.exe`, 10*time.Second) {
		t.Fatal("a process ending a moment later: the update goes on")
	}
	b, _ := os.ReadFile(logPath)
	if !strings.Contains(string(b), "waiting for PDF Editor to end: pid 42 (session 1)") || !strings.Contains(string(b), "ended") {
		t.Fatalf("log: %s", b)
	}
	appProcsFn = func(string) ([]string, []string) { return []string{"pid 42 (session 2)"}, nil }
	t0 := time.Now()
	if waitAppGone(`x.exe`, time.Second) {
		t.Fatal("still running: not now")
	}
	if time.Since(t0) < time.Second {
		t.Fatal("gave up before the time was up")
	}
	b, _ = os.ReadFile(logPath)
	if !strings.Contains(string(b), "still running after 1 s: pid 42 (session 2)") {
		t.Fatalf("log: %s", b)
	}
}

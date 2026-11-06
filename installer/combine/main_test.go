package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSpoolWritesWholeEntries(t *testing.T) {
	dir := t.TempDir()
	for i, p := range []string{`C:\Tender\P04 Rev C.pdf`, `\\server\share\Ärkitektur.pdf`} {
		if err := spool(dir, p, i); err != nil {
			t.Fatal(err)
		}
	}
	m, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(m) != 2 {
		t.Fatalf("want 2 entries, got %v", m)
	}
	for _, f := range m {
		if !strings.HasSuffix(f, ".path") {
			t.Fatalf("left a part-written entry: %s", f)
		}
	}
	b, _ := os.ReadFile(m[1])
	if !strings.Contains(string(b), "Ärkitektur") && !strings.Contains(string(b), "P04") {
		t.Fatalf("content: %q", b)
	}
}

func TestStaleLock(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "launch.lock")
	if !stale(lock) {
		t.Fatal("no lock: stale (free)")
	}
	os.WriteFile(lock, []byte(fmt.Sprintf("%d %d", os.Getpid(), time.Now().UnixMilli())), 0o644)
	if stale(lock) {
		t.Fatal("lock of a running process: not stale")
	}
	os.WriteFile(lock, []byte("999999 1"), 0o644)
	if !stale(lock) {
		t.Fatal("lock of an ended process: stale")
	}
	os.WriteFile(lock, []byte(""), 0o644)
	if stale(lock) {
		t.Fatal("lock being written: not stale")
	}
	old := time.Now().Add(-3 * time.Minute)
	os.WriteFile(lock, []byte(fmt.Sprintf("%d 1", os.Getpid())), 0o644)
	os.Chtimes(lock, old, old)
	if !stale(lock) {
		t.Fatal("lock older than 2 minutes: stale")
	}
}

func TestProfileAndSpoolDir(t *testing.T) {
	if cleanProfile(`comb many/..\x`) != "combmanyx" {
		t.Fatal(cleanProfile(`comb many/..\x`))
	}
	if !strings.HasSuffix(spoolDir(""), filepath.Join("PDF Editor", "combine")) || !strings.HasSuffix(spoolDir("t1"), filepath.Join("PDF Editor", "profile-t1", "combine")) {
		t.Fatal(spoolDir(""), spoolDir("t1"))
	}
}

func TestOursByImageName(t *testing.T) {
	for _, c := range []struct {
		img string
		ok  bool
	}{
		{`C:\Users\n\AppData\Local\Programs\PDF Editor\PDF Editor.exe`, true},
		{`C:\Program Files\PDF Editor\resources\app\bin\PDF Editor Combine.exe`, true},
		{`C:\Windows\System32\notepad.exe`, false},
		{`C:\Tools\Not PDF Editor.exe`, false},
	} {
		if ours(c.img) != c.ok {
			t.Fatalf("%s: want %v", c.img, c.ok)
		}
	}
}

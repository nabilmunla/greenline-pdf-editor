//go:build !windows

// Stand-ins so the core can be built and tested on Linux. The real thing is Windows only.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	mbInfo  = 0x40
	mbWarn  = 0x30
	mbError = 0x10
	mbYesNo = 0x04
	idYes   = 6
)

var testRoot = os.Getenv("PDFED_SETUP_TEST_ROOT")

func messageBox(text string, flags uint32) int { logf("messagebox: %s", text); return idYes }
func isElevated() bool                         { return false }
func otherAdmin() bool                         { return false }
func exeLocked(string) bool                    { return false }
func appRunning(string) bool                   { return false }
func appProcs(string) ([]string, []string)     { return nil, nil }
func fileHolders(string) string                { return "" }
func waitPid(int, time.Duration)               {}
func launch(path string, args ...string) error { return exec.Command(path, args...).Start() }
func launchApp(path string) error                { return launch(path) }
func defaultDir(scope string) string           { return filepath.Join(testRoot, scope, appName) }
func toUNC(p string) string                    { return p }
func userDataDirs() []string                   { return []string{filepath.Join(testRoot, "appdata", appName)} }
func makeShortcuts(string, InstallInfo) error  { return nil }
func removeShortcuts(string, string)           {}
func registerApp(string, InstallInfo) error    { return nil }
func unregisterApp(string, string)             {}
func setRegistryVersion(string, string)        {}
func findInstalled() (string, *InstallInfo)    { return "", nil }
func notifyAssocChanged()                      {}
func openDefaultApps(string)                   {}
func runElevated(j Job, prog progressFn) error { return runJob(nil, j, prog) }
func installUI(p *Payload, st UIState) int     { logf("installUI %+v", st); return 0 }
func uninstallUI(dir, scope string) int        { logf("uninstallUI %s", dir); return 0 }

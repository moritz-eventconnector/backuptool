//go:build !windows

package main

import (
	"context"
	"log"
	"os"
	"syscall"
)

func isWindowsService() bool                                  { return false }
func runWindowsService(_ string, _ func(ctx context.Context)) {}

// reExecAgent replaces the current process image with the new binary (Unix execve).
func reExecAgent(execPath string) {
	if err := syscall.Exec(execPath, os.Args, os.Environ()); err != nil {
		log.Printf("Self-update: re-exec failed: %v — restart the agent manually", err)
	}
}

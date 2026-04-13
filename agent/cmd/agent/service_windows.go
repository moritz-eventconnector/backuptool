//go:build windows

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/windows/svc"
)

type agentSvc struct {
	run func(ctx context.Context)
}

func (s *agentSvc) Execute(_ []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.run(ctx)
	}()

	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		select {
		case <-done:
			status <- svc.Status{State: svc.StopPending}
			cancel()
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(30 * time.Second):
					log.Println("Timeout waiting for agent shutdown")
				}
				return false, 0
			default:
				// Acknowledge any other control codes
				status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
			}
		}
	}
}

// isWindowsService returns true when the process was started by the Windows SCM.
func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// runWindowsService registers with the SCM and runs the agent loop under service control.
func runWindowsService(name string, run func(ctx context.Context)) {
	if err := svc.Run(name, &agentSvc{run: run}); err != nil {
		log.Fatalf("Windows service failed: %v", err)
	}
}

// reExecAgent restarts the Windows service so the newly placed binary is picked up.
// A detached cmd.exe process waits briefly then issues "sc stop / sc start".
// The current process exits immediately after launching the helper.
func reExecAgent(_ string) {
	const svcName = "BackupToolAgent"
	// Spawn a detached cmd.exe that waits ~2 s, restarts the service, then exits.
	script := "ping 127.0.0.1 -n 3 >nul & sc stop " + svcName + " & sc start " + svcName
	cmd := exec.Command("cmd", "/c", script)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		log.Printf("Self-update: could not launch restart helper: %v — restart the service manually", err)
	}
	// Detach: release our reference so cmd.exe outlives this process.
	cmd.Process.Release()
	// Exit this process — SCM will see the service as stopped.
	os.Exit(0)
}

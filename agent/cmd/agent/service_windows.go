//go:build windows

package main

import (
	"context"
	"log"
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

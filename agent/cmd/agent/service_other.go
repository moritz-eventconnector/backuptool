//go:build !windows

package main

import "context"

func isWindowsService() bool                               { return false }
func runWindowsService(_ string, _ func(ctx context.Context)) {}

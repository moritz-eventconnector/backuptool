package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/robfig/cron/v3"

	"github.com/backuptool/agent/internal/backup"
	"github.com/backuptool/agent/internal/client"
	"github.com/backuptool/agent/internal/config"
)

const version = "1.0.0"

func main() {
	// ── Flags ────────────────────────────────────────────────────────────────
	serverURL := flag.String("server", "", "BackupTool server URL (e.g. http://localhost:3000)")
	agentID := flag.String("agent-id", "", "Agent ID (from server registration token)")
	regToken := flag.String("token", "", "Registration token (from server)")
	agentName := flag.String("name", hostname(), "Agent name")
	configPath := flag.String("config", filepath.Join(defaultDataDir(), "agent.yaml"), "Config file path")
	flag.Parse()

	// ── Load or bootstrap config ─────────────────────────────────────────────
	cfg, err := config.Load(*configPath)
	if err != nil {
		cfg = ptr(config.DefaultConfig())
	}
	if *serverURL != "" {
		cfg.ServerURL = *serverURL
	}
	if *agentID != "" {
		cfg.AgentID = *agentID
	}
	if *regToken != "" {
		cfg.Token = *regToken
	}

	if cfg.ServerURL == "" {
		log.Fatal("--server is required")
	}

	// ── Register if not yet registered ───────────────────────────────────────
	if !cfg.IsRegistered() {
		if cfg.Token == "" {
			log.Fatal("Not registered. Provide --token and --agent-id to register.")
		}
		log.Printf("Registering agent with server %s...", cfg.ServerURL)

		initialClient, err := client.NewServerClient(cfg.ServerURL, cfg.AgentID, "", "", "", "")
		if err != nil {
			log.Fatalf("Create client: %v", err)
		}

		resp, err := initialClient.Register(client.RegistrationRequest{
			AgentID:           cfg.AgentID,
			RegistrationToken: cfg.Token,
			Name:              *agentName,
			OS:                runtime.GOOS,
			Arch:              runtime.GOARCH,
			Hostname:          hostname(),
			Version:           version,
		})
		if err != nil {
			log.Fatalf("Registration failed: %v", err)
		}

		cfg.CertPEM = resp.CertPEM
		cfg.KeyPEM = resp.KeyPEM
		cfg.CACertPEM = resp.CACert
		cfg.ApiToken = resp.ApiToken
		cfg.Token = "" // clear after successful registration

		if err := cfg.Save(*configPath); err != nil {
			log.Printf("WARNING: could not save config: %v", err)
		} else {
			log.Printf("Agent registered and config saved to %s", *configPath)
		}
	}

	// ── Create mTLS server client ─────────────────────────────────────────────
	srv, err := client.NewServerClient(cfg.ServerURL, cfg.AgentID, cfg.ApiToken, cfg.CertPEM, cfg.KeyPEM, cfg.CACertPEM)
	if err != nil {
		log.Fatalf("Create server client: %v", err)
	}

	// ── Cron scheduler ───────────────────────────────────────────────────────
	scheduler := cron.New(cron.WithSeconds())
	scheduler.Start()
	defer scheduler.Stop()

	// ── Main agent loop ───────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	log.Printf("BackupTool Agent v%s started | server: %s | agent: %s", version, cfg.ServerURL, cfg.AgentID)

	runner := &backup.Runner{ResticBin: cfg.ResticBin}

	for {
		select {
		case <-ctx.Done():
			log.Println("Shutting down agent...")
			return
		default:
		}

		conn, err := connectWithRetry(ctx, srv)
		if err != nil {
			log.Printf("Could not connect to server: %v — retrying in 30s", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
				continue
			}
		}

		log.Println("Connected to server via WebSocket")
		handleConnection(ctx, conn, srv, scheduler, runner)
	}
}

func connectWithRetry(ctx context.Context, srv *client.ServerClient) (*websocket.Conn, error) {
	for {
		conn, err := srv.ConnectWebSocket()
		if err == nil {
			return conn, nil
		}
		log.Printf("WebSocket connect failed: %v", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Second):
		}
	}
}

func handleConnection(
	ctx context.Context,
	conn *websocket.Conn,
	srv *client.ServerClient,
	scheduler *cron.Cron,
	runner *backup.Runner,
) {
	defer conn.Close()

	// Heartbeat goroutine
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteJSON(map[string]string{"type": "heartbeat"}); err != nil {
					return
				}
			}
		}
	}()

	// Sync jobs from server
	syncJobs(ctx, srv, scheduler, runner, conn)

	// Message loop
	for {
		var msg map[string]json.RawMessage
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			log.Printf("WebSocket read error: %v", err)
			return
		}

		var msgType string
		json.Unmarshal(msg["type"], &msgType)

		switch msgType {
		case "run_job":
			var jobID, snapshotID string
			json.Unmarshal(msg["jobId"], &jobID)
			json.Unmarshal(msg["snapshotId"], &snapshotID)

			// Fetch full job config (with decrypted destinations + password) from internal API
			go func() {
				jobCfg, err := srv.GetJobConfig(jobID)
				if err != nil {
					log.Printf("Failed to fetch job config for %s: %v", jobID, err)
					sendSnapshotDone(conn, snapshotID, "failed", nil, fmt.Sprintf("failed to fetch job config: %v", err))
					return
				}
				runBackup(ctx, conn, runner, jobCfg, snapshotID)
			}()

		case "sync_jobs":
			syncJobs(ctx, srv, scheduler, runner, conn)

		case "restore":
			var resticSnapshotID, restorePath, destinationID string
			json.Unmarshal(msg["resticSnapshotId"], &resticSnapshotID)
			json.Unmarshal(msg["restorePath"], &restorePath)
			json.Unmarshal(msg["destinationId"], &destinationID)
			go func() {
				if err := handleRestore(ctx, srv, runner, resticSnapshotID, restorePath, destinationID); err != nil {
					log.Printf("Restore failed: %v", err)
				}
			}()

		case "list_files":
			var resticSnapshotID, path string
			json.Unmarshal(msg["resticSnapshotId"], &resticSnapshotID)
			json.Unmarshal(msg["path"], &path)
			go func() {
				files, err := handleListFiles(ctx, srv, runner, resticSnapshotID, path)
				reply := map[string]interface{}{
					"type":             "list_files_result",
					"resticSnapshotId": resticSnapshotID,
				}
				if err != nil {
					reply["error"] = err.Error()
				} else {
					reply["files"] = files
				}
				conn.WriteJSON(reply)
			}()

		case "forget_snapshot":
			var resticSnapshotID, destinationID string
			json.Unmarshal(msg["resticSnapshotId"], &resticSnapshotID)
			json.Unmarshal(msg["destinationId"], &destinationID)
			go func() {
				if err := handleForgetSnapshot(ctx, srv, runner, resticSnapshotID, destinationID); err != nil {
					log.Printf("Forget snapshot failed: %v", err)
				}
			}()

		case "pong":
			// heartbeat response — ignore

		default:
			log.Printf("Unknown message type: %s", msgType)
		}
	}
}

func runBackup(ctx context.Context, conn *websocket.Conn, runner *backup.Runner, job *client.JobConfig, snapshotID string) {
	log.Printf("Starting backup job %s (snapshot %s)", job.ID, snapshotID)

	if len(job.Destinations) == 0 {
		sendSnapshotDone(conn, snapshotID, "failed", nil, "no destinations configured for job")
		return
	}

	// Run pre-script if configured
	if job.PreScript != "" {
		if err := runScript(job.PreScript); err != nil {
			sendSnapshotDone(conn, snapshotID, "failed", nil, fmt.Sprintf("pre-script failed: %v", err))
			return
		}
	}

	progressCh := make(chan backup.ProgressUpdate, 32)
	go func() {
		for p := range progressCh {
			conn.WriteJSON(map[string]interface{}{
				"type":       "progress",
				"snapshotId": p.SnapshotID,
				"percent":    p.Percent,
				"filesDone":  p.FilesDone,
				"filesNew":   p.FilesNew,
				"sizeDone":   p.SizeDone,
				"sizeTotal":  p.SizeTotal,
			})
		}
	}()

	// Convert job config to backup.Job and Destination
	backupJob := &backup.Job{
		ID:                job.ID,
		Name:              job.Name,
		SourcePaths:       job.SourcePaths,
		Schedule:          job.Schedule,
		PreScript:         job.PreScript,
		PostScript:        job.PostScript,
		ExcludePatterns:   job.ExcludePatterns,
		MaxRetries:        job.MaxRetries,
		RetryDelaySeconds: job.RetryDelaySeconds,
	}
	// Parse retention from map
	if r, ok := job.Retention["keepLast"].(float64); ok {
		backupJob.Retention.KeepLast = int(r)
	}
	if r, ok := job.Retention["keepDaily"].(float64); ok {
		backupJob.Retention.KeepDaily = int(r)
	}
	if r, ok := job.Retention["keepWeekly"].(float64); ok {
		backupJob.Retention.KeepWeekly = int(r)
	}
	if r, ok := job.Retention["keepMonthly"].(float64); ok {
		backupJob.Retention.KeepMonthly = int(r)
	}
	if r, ok := job.Retention["keepYearly"].(float64); ok {
		backupJob.Retention.KeepYearly = int(r)
	}

	// Use the first destination (multiple destinations = run backup multiple times)
	var lastResult *backup.Result
	var lastErr error
	for _, d := range job.Destinations {
		dest := &backup.Destination{
			ID:     d.ID,
			Name:   d.Name,
			Type:   d.Type,
			Config: d.Config,
		}
		result, err := runner.Run(ctx, backupJob, dest, snapshotID, job.ResticPassword, progressCh)
		if err != nil {
			lastErr = err
		} else {
			lastResult = result
		}
	}
	close(progressCh)

	if lastErr != nil && lastResult == nil {
		sendSnapshotDone(conn, snapshotID, "failed", nil, lastErr.Error())
		return
	}

	// Run post-script
	if job.PostScript != "" {
		if err := runScript(job.PostScript); err != nil {
			log.Printf("post-script failed (non-fatal): %v", err)
		}
	}

	sendSnapshotDone(conn, snapshotID, lastResult.Status, lastResult, lastResult.ErrorMessage)
}

func handleRestore(ctx context.Context, srv *client.ServerClient, runner *backup.Runner, resticSnapshotID, restorePath, destinationID string) error {
	// Get job configs to find the destination
	jobs, err := srv.GetJobConfigs()
	if err != nil {
		return fmt.Errorf("fetch job configs: %w", err)
	}

	for _, job := range jobs {
		for _, d := range job.Destinations {
			if d.ID == destinationID {
				dest := &backup.Destination{
					ID:     d.ID,
					Name:   d.Name,
					Type:   d.Type,
					Config: d.Config,
				}
				return runner.Restore(ctx, dest, resticSnapshotID, restorePath, job.ResticPassword)
			}
		}
	}
	return fmt.Errorf("destination %s not found in any job", destinationID)
}

func handleListFiles(ctx context.Context, srv *client.ServerClient, runner *backup.Runner, resticSnapshotID, path string) ([]map[string]interface{}, error) {
	jobs, err := srv.GetJobConfigs()
	if err != nil {
		return nil, fmt.Errorf("fetch job configs: %w", err)
	}
	// Use the first available destination that has this snapshot
	for _, job := range jobs {
		for _, d := range job.Destinations {
			dest := &backup.Destination{ID: d.ID, Name: d.Name, Type: d.Type, Config: d.Config}
			files, err := runner.ListFiles(ctx, dest, resticSnapshotID, path, job.ResticPassword)
			if err == nil {
				return files, nil
			}
		}
	}
	return nil, fmt.Errorf("snapshot %s not found in any destination", resticSnapshotID)
}

func handleForgetSnapshot(ctx context.Context, srv *client.ServerClient, runner *backup.Runner, resticSnapshotID, destinationID string) error {
	jobs, err := srv.GetJobConfigs()
	if err != nil {
		return fmt.Errorf("fetch job configs: %w", err)
	}
	for _, job := range jobs {
		for _, d := range job.Destinations {
			if destinationID != "" && d.ID != destinationID {
				continue
			}
			dest := &backup.Destination{ID: d.ID, Name: d.Name, Type: d.Type, Config: d.Config}
			if err := runner.ForgetSnapshot(ctx, dest, resticSnapshotID, job.ResticPassword); err == nil {
				return nil
			}
		}
	}
	return fmt.Errorf("could not forget snapshot %s", resticSnapshotID)
}

func sendSnapshotDone(conn *websocket.Conn, snapshotID, status string, result *backup.Result, errMsg string) {
	msg := map[string]interface{}{
		"type":       "snapshot_done",
		"snapshotId": snapshotID,
		"status":     status,
	}
	if result != nil {
		msg["resticSnapshotId"] = result.ResticSnapshotID
		msg["sizeBytes"] = result.SizeBytes
		msg["fileCount"] = result.FileCount
		msg["durationSeconds"] = result.DurationSeconds
	}
	if errMsg != "" {
		msg["errorMessage"] = errMsg
	}
	conn.WriteJSON(msg)
}

func syncJobs(ctx context.Context, srv *client.ServerClient, scheduler *cron.Cron, runner *backup.Runner, conn *websocket.Conn) {
	jobs, err := srv.GetJobConfigs()
	if err != nil {
		log.Printf("Failed to fetch jobs: %v", err)
		return
	}

	// Clear existing entries
	for _, entry := range scheduler.Entries() {
		scheduler.Remove(entry.ID)
	}

	for _, job := range jobs {
		if !job.Enabled || job.Schedule == "" {
			continue
		}
		j := job // capture
		scheduler.AddFunc(j.Schedule, func() {
			snapshotID := fmt.Sprintf("auto-%d", time.Now().UnixMilli())
			runBackup(ctx, conn, runner, &j, snapshotID)
		})
		log.Printf("Scheduled job %s: %s", j.Name, j.Schedule)
	}
}

func runScript(script string) error {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", script)
	} else {
		cmd = exec.Command("sh", "-c", script)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, string(out))
	}
	return nil
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/var/lib/backuptool-agent"
	}
	return filepath.Join(home, ".backuptool-agent")
}

func ptr[T any](v T) *T { return &v }

// Suppress unused import warning for net/http
var _ = http.StatusOK

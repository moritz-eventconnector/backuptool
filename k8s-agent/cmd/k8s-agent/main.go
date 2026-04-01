package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/robfig/cron/v3"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/backuptool/k8s-agent/internal/backup"
	"github.com/backuptool/k8s-agent/internal/client"
	"github.com/backuptool/k8s-agent/internal/config"
)

const version = "1.0.0"

func main() {
	cfg := config.Load()

	if cfg.ServerURL == "" {
		log.Fatal("SERVER_URL environment variable is required")
	}
	if cfg.AgentID == "" {
		log.Fatal("AGENT_ID environment variable is required")
	}

	// Try to load previously persisted mTLS certs + API token (survive pod restarts).
	cfg.LoadCerts()

	// Register with the server if we do not yet have mTLS credentials.
	if !cfg.IsRegistered() {
		if cfg.Token == "" {
			log.Fatal("AGENT_TOKEN is required for initial registration")
		}
		if err := registerAgent(cfg); err != nil {
			log.Fatalf("Registration failed: %v", err)
		}
	}

	// Build the authenticated server client.
	srv, err := client.NewServerClient(cfg.ServerURL, cfg.AgentID, cfg.ApiToken, cfg.CertPEM, cfg.KeyPEM, cfg.CACertPEM)
	if err != nil {
		log.Fatalf("Create server client: %v", err)
	}

	// Build the Kubernetes in-cluster client.
	kubeClient, err := newKubeClient()
	if err != nil {
		log.Fatalf("Create Kubernetes client: %v", err)
	}

	runner := &backup.K8sBackupRunner{
		ResticBin:  cfg.ResticBin,
		KubeClient: kubeClient,
	}

	scheduler := cron.New(cron.WithSeconds())
	scheduler.Start()
	defer scheduler.Stop()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	log.Printf("BackupTool K8s Agent v%s | server: %s | agent: %s | namespace: %q",
		version, cfg.ServerURL, cfg.AgentID, cfg.BackupNamespace)

	for {
		select {
		case <-ctx.Done():
			log.Println("Shutting down k8s agent...")
			return
		default:
		}

		conn, err := connectWithRetry(ctx, srv)
		if err != nil {
			return // ctx cancelled
		}

		log.Println("Connected to server via WebSocket")
		handleConnection(ctx, conn, srv, cfg, scheduler, runner)
		log.Println("WebSocket connection closed — reconnecting...")
	}
}

func registerAgent(cfg *config.Config) error {
	initialClient, err := client.NewServerClient(cfg.ServerURL, cfg.AgentID, "", "", "", "")
	if err != nil {
		return fmt.Errorf("create registration client: %w", err)
	}

	log.Printf("Registering agent %s with %s...", cfg.AgentID, cfg.ServerURL)

	resp, err := initialClient.Register(client.RegistrationRequest{
		AgentID:           cfg.AgentID,
		RegistrationToken: cfg.Token,
		Name:              cfg.AgentID,
		OS:                "kubernetes",
		Arch:              runtime.GOARCH,
		Hostname:          hostname(),
		Version:           version,
		Tags:              []string{"kubernetes"},
	})
	if err != nil {
		return err
	}

	cfg.CertPEM = resp.CertPEM
	cfg.KeyPEM = resp.KeyPEM
	cfg.CACertPEM = resp.CACert
	cfg.ApiToken = resp.ApiToken
	cfg.Token = ""

	if err := cfg.SaveCerts(); err != nil {
		log.Printf("WARNING: could not persist certs to %s: %v", cfg.DataDir, err)
	} else {
		log.Printf("Agent registered; certs saved to %s", cfg.DataDir)
	}
	return nil
}

func connectWithRetry(ctx context.Context, srv *client.ServerClient) (*websocket.Conn, error) {
	for {
		conn, err := srv.ConnectWebSocket()
		if err == nil {
			return conn, nil
		}
		log.Printf("WebSocket connect failed: %v — retrying in 10s", err)
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
	cfg *config.Config,
	scheduler *cron.Cron,
	runner *backup.K8sBackupRunner,
) {
	defer conn.Close()

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

	syncJobs(ctx, srv, scheduler, runner, conn, cfg)

	for {
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			log.Printf("WebSocket read error: %v", err)
			return
		}

		msgType, _ := msg["type"].(string)
		switch msgType {
		case "run_job":
			jobID, _ := msg["jobId"].(string)
			snapshotID, _ := msg["snapshotId"].(string)
			go func() {
				jobCfg, err := srv.GetJobConfigs()
				if err != nil {
					sendSnapshotDone(conn, snapshotID, "failed", nil, fmt.Sprintf("fetch jobs: %v", err))
					return
				}
				for _, j := range jobCfg {
					if j.ID == jobID {
						runBackup(ctx, conn, runner, &j, cfg.BackupNamespace, snapshotID)
						return
					}
				}
				sendSnapshotDone(conn, snapshotID, "failed", nil, "job not found: "+jobID)
			}()

		case "sync_jobs":
			syncJobs(ctx, srv, scheduler, runner, conn, cfg)

		case "restore":
			resticSnapshotID, _ := msg["resticSnapshotId"].(string)
			jobID, _ := msg["jobId"].(string)
			restorePath, _ := msg["restorePath"].(string)
			if restorePath == "" {
				restorePath = "/tmp/restore-" + resticSnapshotID
			}
			go func() {
				jobs, err := srv.GetJobConfigs()
				if err != nil {
					log.Printf("Restore: fetch jobs failed: %v", err)
					return
				}
				for _, j := range jobs {
					if j.ID == jobID && len(j.Destinations) > 0 {
						d := j.Destinations[0]
						dest := &backup.Destination{ID: d.ID, Name: d.Name, Type: d.Type, Config: d.Config}
						if err := runner.Restore(ctx, dest, resticSnapshotID, restorePath, j.ResticPassword); err != nil {
							log.Printf("Restore snapshot %s failed: %v", resticSnapshotID, err)
						} else {
							log.Printf("Restore snapshot %s → %s completed", resticSnapshotID, restorePath)
						}
						return
					}
				}
				log.Printf("Restore: job %s not found", jobID)
			}()

		case "pong":
			// heartbeat response — ignore

		default:
			if msgType != "" {
				log.Printf("Unknown message type: %s", msgType)
			}
		}
	}
}

func runBackup(
	ctx context.Context,
	conn *websocket.Conn,
	runner *backup.K8sBackupRunner,
	job *client.JobConfig,
	namespace string,
	snapshotID string,
) {
	log.Printf("Starting k8s backup job %s (snapshot %s)", job.Name, snapshotID)

	if len(job.Destinations) == 0 {
		sendSnapshotDone(conn, snapshotID, "failed", nil, "no destinations configured")
		return
	}

	progressCh := make(chan backup.ProgressUpdate, 32)
	go func() {
		for p := range progressCh {
			conn.WriteJSON(map[string]interface{}{ //nolint:errcheck
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

	// Convert first destination
	d := job.Destinations[0]
	dest := &backup.Destination{
		ID:     d.ID,
		Name:   d.Name,
		Type:   d.Type,
		Config: d.Config,
	}

	// Build backup.Job from JobConfig
	backupJob := &backup.Job{
		ID:                job.ID,
		Name:              job.Name,
		SourcePaths:       job.SourcePaths,
		Schedule:          job.Schedule,
		WormEnabled:       job.WormEnabled,
		WormRetentionDays: job.WormRetentionDays,
	}

	result, err := runner.Run(ctx, backupJob, dest, namespace, snapshotID, job.ResticPassword, progressCh)
	close(progressCh)

	if err != nil {
		sendSnapshotDone(conn, snapshotID, "failed", nil, err.Error())
		return
	}
	sendSnapshotDone(conn, snapshotID, result.Status, result, result.ErrorMessage)
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
	conn.WriteJSON(msg) //nolint:errcheck
}

func syncJobs(
	ctx context.Context,
	srv *client.ServerClient,
	scheduler *cron.Cron,
	runner *backup.K8sBackupRunner,
	conn *websocket.Conn,
	cfg *config.Config,
) {
	jobs, err := srv.GetJobConfigs()
	if err != nil {
		log.Printf("Failed to fetch jobs: %v", err)
		return
	}

	for _, entry := range scheduler.Entries() {
		scheduler.Remove(entry.ID)
	}

	for _, job := range jobs {
		if !job.Enabled || job.Schedule == "" {
			continue
		}
		j := job
		scheduler.AddFunc(j.Schedule, func() { //nolint:errcheck
			snapshotID := fmt.Sprintf("auto-%d", time.Now().UnixMilli())
			runBackup(ctx, conn, runner, &j, cfg.BackupNamespace, snapshotID)
		})
		log.Printf("Scheduled k8s job %q: %s", j.Name, j.Schedule)
	}
}

func newKubeClient() (*kubernetes.Clientset, error) {
	restCfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("in-cluster config: %w", err)
	}
	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("kubernetes clientset: %w", err)
	}
	return cs, nil
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

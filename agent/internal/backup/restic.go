package backup

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Job represents a backup job received from the server.
type Job struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	SourcePaths      []string          `json:"sourcePaths"`
	DestinationIds   []string          `json:"destinationIds"`
	Schedule         string            `json:"schedule"`
	Retention        RetentionPolicy   `json:"retention"`
	PreScript        string            `json:"preScript"`
	PostScript       string            `json:"postScript"`
	ExcludePatterns  []string          `json:"excludePatterns"`
	MaxRetries       int               `json:"maxRetries"`
	RetryDelaySeconds int              `json:"retryDelaySeconds"`
}

type RetentionPolicy struct {
	KeepLast    int `json:"keepLast"`
	KeepDaily   int `json:"keepDaily"`
	KeepWeekly  int `json:"keepWeekly"`
	KeepMonthly int `json:"keepMonthly"`
	KeepYearly  int `json:"keepYearly"`
}

// Destination represents a storage backend.
type Destination struct {
	ID     string                 `json:"id"`
	Name   string                 `json:"name"`
	Type   string                 `json:"type"`
	Config map[string]interface{} `json:"config"`
}

// ProgressUpdate is emitted during backup execution.
type ProgressUpdate struct {
	SnapshotID   string  `json:"snapshotId"`
	Percent      float64 `json:"percent"`
	FilesNew     int     `json:"filesNew"`
	FilesDone    int     `json:"filesDone"`
	SizeTotal    int64   `json:"sizeTotal"`
	SizeDone     int64   `json:"sizeDone"`
	CurrentFile  string  `json:"currentFile"`
}

// Result is the final result of a backup run.
type Result struct {
	SnapshotID       string  `json:"snapshotId"`
	ResticSnapshotID string  `json:"resticSnapshotId"`
	SizeBytes        int64   `json:"sizeBytes"`
	FileCount        int     `json:"fileCount"`
	DurationSeconds  float64 `json:"durationSeconds"`
	Status           string  `json:"status"`
	ErrorMessage     string  `json:"errorMessage,omitempty"`
}

type Runner struct {
	ResticBin string
	RepoDir   string // local cache directory for restic repo metadata
}

// Run executes a restic backup for the given job and destination.
// progressCh receives real-time progress updates.
func (r *Runner) Run(
	ctx context.Context,
	job *Job,
	dest *Destination,
	snapshotID string,
	password string,
	progressCh chan<- ProgressUpdate,
) (*Result, error) {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return nil, fmt.Errorf("build repo config: %w", err)
	}

	env = append(env, "RESTIC_PASSWORD="+password)

	// Ensure repo is initialized
	if err := r.initRepo(ctx, repoURL, env); err != nil {
		return nil, fmt.Errorf("init repo: %w", err)
	}

	// Build restic backup command
	args := []string{"backup", "--json", "--verbose"}
	for _, p := range job.ExcludePatterns {
		args = append(args, "--exclude="+p)
	}
	args = append(args, job.SourcePaths...)

	cmd := exec.CommandContext(ctx, r.ResticBin, args...)
	cmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &strings.Builder{}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start restic: %w", err)
	}

	var finalSnapshot string
	var fileDone, fileNew int
	var sizeDone, sizeTotal int64

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		msgType, _ := msg["message_type"].(string)

		switch msgType {
		case "status":
			pct, _ := msg["percent_done"].(float64)
			fn, _ := msg["files_new"].(float64)
			fd, _ := msg["files_done"].(float64)
			st, _ := msg["total_bytes"].(float64)
			sd, _ := msg["bytes_done"].(float64)
			cf, _ := msg["current_files"].([]interface{})
			currentFile := ""
			if len(cf) > 0 {
				currentFile, _ = cf[0].(string)
			}
			fileNew = int(fn)
			fileDone = int(fd)
			sizeTotal = int64(st)
			sizeDone = int64(sd)

			if progressCh != nil {
				select {
				case progressCh <- ProgressUpdate{
					SnapshotID:  snapshotID,
					Percent:     pct * 100,
					FilesNew:    fileNew,
					FilesDone:   fileDone,
					SizeTotal:   sizeTotal,
					SizeDone:    sizeDone,
					CurrentFile: currentFile,
				}:
				default:
				}
			}
		case "summary":
			snapshotIDVal, _ := msg["snapshot_id"].(string)
			finalSnapshot = snapshotIDVal
			sf, _ := msg["files_new"].(float64)
			fileNew = int(sf)
			ss, _ := msg["total_bytes_processed"].(float64)
			sizeDone = int64(ss)
		}
	}

	if err := cmd.Wait(); err != nil {
		errMsg := stderr.String()
		return &Result{
			SnapshotID:   snapshotID,
			Status:       "failed",
			ErrorMessage: fmt.Sprintf("restic exited with error: %v\n%s", err, errMsg),
		}, nil
	}

	// Apply retention policy
	if err := r.applyRetention(ctx, job.Retention, repoURL, env); err != nil {
		// Non-fatal: log but don't fail the backup
		_ = err
	}

	return &Result{
		SnapshotID:       snapshotID,
		ResticSnapshotID: finalSnapshot,
		SizeBytes:        sizeDone,
		FileCount:        fileDone + fileNew,
		Status:           "success",
	}, nil
}

// Restore runs restic restore for a given snapshot.
func (r *Runner) Restore(ctx context.Context, dest *Destination, resticSnapshotID, targetPath, password string) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	cmd := exec.CommandContext(ctx, r.ResticBin, "restore", resticSnapshotID, "--target", targetPath)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic restore failed: %v\n%s", err, string(out))
	}
	return nil
}

// ListFiles lists files in a specific snapshot at a given path.
func (r *Runner) ListFiles(ctx context.Context, dest *Destination, resticSnapshotID, path, password string) ([]map[string]interface{}, error) {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return nil, err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	if path == "" {
		path = "/"
	}
	cmd := exec.CommandContext(ctx, r.ResticBin, "ls", "--json", resticSnapshotID, path)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("restic ls: %w", err)
	}

	var files []map[string]interface{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]interface{}
		if err := json.Unmarshal([]byte(line), &entry); err == nil {
			files = append(files, entry)
		}
	}
	return files, nil
}

// ForgetSnapshot removes a single snapshot from the repository.
func (r *Runner) ForgetSnapshot(ctx context.Context, dest *Destination, resticSnapshotID, password string) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	cmd := exec.CommandContext(ctx, r.ResticBin, "forget", "--prune", resticSnapshotID)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic forget: %v\n%s", err, string(out))
	}
	return nil
}

// ListSnapshots lists all snapshots in a repo.
func (r *Runner) ListSnapshots(ctx context.Context, dest *Destination, password string) ([]map[string]interface{}, error) {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return nil, err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	cmd := exec.CommandContext(ctx, r.ResticBin, "snapshots", "--json")
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("restic snapshots: %w", err)
	}
	var snaps []map[string]interface{}
	if err := json.Unmarshal(out, &snaps); err != nil {
		return nil, err
	}
	return snaps, nil
}

func (r *Runner) initRepo(ctx context.Context, repoURL string, env []string) error {
	// Check if repo exists first
	checkCmd := exec.CommandContext(ctx, r.ResticBin, "cat", "config")
	checkCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	if err := checkCmd.Run(); err == nil {
		return nil // repo already exists
	}

	// Init new repo
	initCmd := exec.CommandContext(ctx, r.ResticBin, "init")
	initCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	out, err := initCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic init: %v\n%s", err, string(out))
	}
	return nil
}

func (r *Runner) applyRetention(ctx context.Context, policy RetentionPolicy, repoURL string, env []string) error {
	args := []string{"forget", "--prune"}
	if policy.KeepLast > 0 {
		args = append(args, "--keep-last", strconv.Itoa(policy.KeepLast))
	}
	if policy.KeepDaily > 0 {
		args = append(args, "--keep-daily", strconv.Itoa(policy.KeepDaily))
	}
	if policy.KeepWeekly > 0 {
		args = append(args, "--keep-weekly", strconv.Itoa(policy.KeepWeekly))
	}
	if policy.KeepMonthly > 0 {
		args = append(args, "--keep-monthly", strconv.Itoa(policy.KeepMonthly))
	}
	if policy.KeepYearly > 0 {
		args = append(args, "--keep-yearly", strconv.Itoa(policy.KeepYearly))
	}
	if len(args) == 2 {
		return nil // no retention policy
	}

	cmd := exec.CommandContext(ctx, r.ResticBin, args...)
	cmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	return cmd.Run()
}

// buildRepoURLAndEnv constructs the RESTIC_REPOSITORY URL and required env vars for a destination.
func (r *Runner) buildRepoURLAndEnv(dest *Destination) (string, []string, error) {
	get := func(key string) string {
		v, _ := dest.Config[key].(string)
		return v
	}

	switch dest.Type {
	case "s3", "wasabi", "minio":
		bucket := get("bucket")
		region := get("region")
		endpoint := get("endpoint")
		path := strings.TrimPrefix(get("path"), "/")

		repoURL := "s3:"
		if endpoint != "" {
			repoURL += endpoint + "/"
		} else {
			repoURL += "s3.amazonaws.com/"
		}
		repoURL += bucket
		if path != "" {
			repoURL += "/" + path
		}

		env := []string{
			"AWS_ACCESS_KEY_ID=" + get("accessKeyId"),
			"AWS_SECRET_ACCESS_KEY=" + get("secretAccessKey"),
		}
		if region != "" {
			env = append(env, "AWS_DEFAULT_REGION="+region)
		}
		return repoURL, env, nil

	case "b2":
		bucket := get("bucket")
		path := strings.TrimPrefix(get("path"), "/")
		repoURL := "b2:" + bucket
		if path != "" {
			repoURL += "/" + path
		}
		env := []string{
			"B2_ACCOUNT_ID=" + get("accountId"),
			"B2_ACCOUNT_KEY=" + get("applicationKey"),
		}
		return repoURL, env, nil

	case "local":
		return get("path"), nil, nil

	case "sftp":
		port := get("port")
		if port == "" {
			port = "22"
		}
		host := get("host")
		user := get("user")
		path := get("path")
		repoURL := fmt.Sprintf("sftp:%s@%s:%s%s", user, host, port, path)
		return repoURL, nil, nil

	case "rclone":
		return "rclone:" + get("remote"), nil, nil

	case "gcs":
		bucket := get("bucket")
		path := strings.TrimPrefix(get("path"), "/")

		// Write credentials to temp file
		credJSON := get("credentialsJson")
		credFile := filepath.Join(os.TempDir(), "backuptool-gcs-creds.json")
		if err := os.WriteFile(credFile, []byte(credJSON), 0600); err != nil {
			return "", nil, fmt.Errorf("write GCS credentials: %w", err)
		}

		repoURL := "gs:" + bucket + ":/" + path
		env := []string{"GOOGLE_APPLICATION_CREDENTIALS=" + credFile}
		return repoURL, env, nil

	default:
		return "", nil, fmt.Errorf("unsupported destination type: %s", dest.Type)
	}
}

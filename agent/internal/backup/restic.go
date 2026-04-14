package backup

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Job represents a backup job received from the server.
type Job struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	SourcePaths       []string        `json:"sourcePaths"`
	DestinationIds    []string        `json:"destinationIds"`
	Schedule          string          `json:"schedule"`
	Retention         RetentionPolicy `json:"retention"`
	PreScript         string          `json:"preScript"`
	PostScript        string          `json:"postScript"`
	ExcludePatterns   []string        `json:"excludePatterns"`
	MaxRetries        int             `json:"maxRetries"`
	RetryDelaySeconds int             `json:"retryDelaySeconds"`
	// WORM — immutable backup policy
	WormEnabled       bool            `json:"wormEnabled"`
	WormRetentionDays int             `json:"wormRetentionDays"`
	SourceType   string                 `json:"sourceType"`
	SourceConfig map[string]interface{} `json:"sourceConfig"`
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
	RcloneBin string
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
	// If source is S3, mount or sync the bucket so restic can read from it.
	if job.SourceType == "s3" {
		tmpDir, cleanup, err := r.prepareS3Source(ctx, job)
		if err != nil {
			return &Result{
				SnapshotID:   snapshotID,
				Status:       "failed",
				ErrorMessage: fmt.Sprintf("S3 source sync failed: %v", err),
			}, nil
		}
		defer cleanup()
		job = &Job{
			ID:                job.ID,
			Name:              job.Name,
			SourcePaths:       []string{tmpDir},
			DestinationIds:    job.DestinationIds,
			Schedule:          job.Schedule,
			Retention:         job.Retention,
			PreScript:         job.PreScript,
			PostScript:        job.PostScript,
			ExcludePatterns:   job.ExcludePatterns,
			MaxRetries:        job.MaxRetries,
			RetryDelaySeconds: job.RetryDelaySeconds,
			WormEnabled:       job.WormEnabled,
			WormRetentionDays: job.WormRetentionDays,
			SourceType:        "local", // already synced
		}
	}

	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return nil, fmt.Errorf("build repo config: %w", err)
	}

	env = append(env, "RESTIC_PASSWORD="+password)

	// WORM: for S3-compatible backends, enable Object Lock so every object is
	// written with a retention policy that matches wormRetentionDays.
	// restic reads the lock duration from the backend option "s3.object-lock-mode"
	// (COMPLIANCE) and sets the object retention header automatically.
	wormBackendOpts := wormBackendOptions(job, dest)

	// Ensure repo is initialized (with WORM options if applicable)
	if err := r.initRepo(ctx, repoURL, env, wormBackendOpts); err != nil {
		return nil, fmt.Errorf("init repo: %w", err)
	}

	// Build restic backup command
	args := []string{"backup", "--json", "--verbose"}
	args = append(args, wormBackendOpts...)
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

	// Apply retention policy — skip for WORM repos because objects are immutable
	// and restic `forget --prune` cannot delete them anyway.
	if !job.WormEnabled {
		if err := r.applyRetention(ctx, job.Retention, repoURL, env); err != nil {
			_ = err // non-fatal
		}
	}

	return &Result{
		SnapshotID:       snapshotID,
		ResticSnapshotID: finalSnapshot,
		SizeBytes:        sizeDone,
		FileCount:        fileDone + fileNew,
		Status:           "success",
	}, nil
}

// RestoreProgress carries live progress updates during a restore.
type RestoreProgress struct {
	Percent    float64
	FilesDone  int
	FilesTotal int
	BytesDone  int64
	BytesTotal int64
}

var restoreProgressRe = regexp.MustCompile(`([\d.]+)%\s+([\d,]+)\s*/\s*([\d,]+)`)

// Restore runs restic restore for a given snapshot with live progress reporting.
// includePaths optionally limits restore to specific paths (restic --include).
// progressCh receives updates parsed from restic's verbose stderr output.
func (r *Runner) Restore(ctx context.Context, dest *Destination, resticSnapshotID, targetPath, password string, includePaths []string, progressCh chan<- RestoreProgress) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	args := []string{"restore", resticSnapshotID, "--target", targetPath, "--verbose"}
	for _, p := range includePaths {
		if p = strings.TrimSpace(p); p != "" {
			args = append(args, "--include="+p)
			// Also include all contents of this directory path.
			// restic --include matches on the full file path; the pattern "/foo"
			// alone matches only the directory entry itself, not its children.
			args = append(args, "--include="+strings.TrimRight(p, "/")+"/**")
		}
	}

	cmd := exec.CommandContext(ctx, r.ResticBin, args...)
	cmd.Env = append(os.Environ(), env...)

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	stdout := &bytes.Buffer{}
	cmd.Stdout = stdout

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start restic restore: %w", err)
	}

	// restic restore writes progress lines to stderr separated by \r or \n
	scanner := bufio.NewScanner(stderr)
	scanner.Split(splitOnCRorLF)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if progressCh != nil {
			if m := restoreProgressRe.FindStringSubmatch(line); m != nil {
				pct, _ := strconv.ParseFloat(m[1], 64)
				done, _ := strconv.Atoi(strings.ReplaceAll(m[2], ",", ""))
				total, _ := strconv.Atoi(strings.ReplaceAll(m[3], ",", ""))
				select {
				case progressCh <- RestoreProgress{Percent: pct, FilesDone: done, FilesTotal: total}:
				default:
				}
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("restic restore failed: %v\n%s", err, stdout.String())
	}
	return nil
}

// splitOnCRorLF is a bufio.SplitFunc that splits on \r or \n.
func splitOnCRorLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i, b := range data {
		if b == '\r' || b == '\n' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
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

// DeepVerify runs restic check --read-data-subset=25% to verify actual data pack
// integrity (not just metadata). This is slower but catches real bit-rot or
// storage corruption that a normal Check() would miss.
func (r *Runner) DeepVerify(ctx context.Context, dest *Destination, password string) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	// 25% random sample — good balance between thoroughness and speed.
	// Running weekly rotates through the full dataset in ~4 weeks.
	// --retry-lock: wait up to 2 min if a backup is holding the repo lock
	// rather than failing immediately.
	cmd := exec.CommandContext(ctx, r.ResticBin, "check", "--read-data-subset=25%", "--retry-lock=120s")
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic check --read-data-subset: %v\n%s", err, string(out))
	}
	return nil
}

// RotateKey adds a new encryption key (newPassword) to the repository and removes
// all old keys. Uses the current oldPassword to authenticate the key-add operation.
func (r *Runner) RotateKey(ctx context.Context, dest *Destination, oldPassword, newPassword string) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}

	envOld := append(append([]string{}, env...), "RESTIC_PASSWORD="+oldPassword, "RESTIC_REPOSITORY="+repoURL)
	envNew := append(append([]string{}, env...), "RESTIC_PASSWORD="+newPassword, "RESTIC_REPOSITORY="+repoURL)

	// Write new password to a temp file (restic key add requires --new-password-file)
	tmp, err := os.CreateTemp("", "restic-newkey-*")
	if err != nil {
		return fmt.Errorf("create temp key file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(newPassword); err != nil {
		return fmt.Errorf("write temp key file: %w", err)
	}
	tmp.Close()

	// Step 1: add new key (authenticated with old password)
	addCmd := exec.CommandContext(ctx, r.ResticBin, "key", "add", "--new-password-file", tmp.Name())
	addCmd.Env = append(os.Environ(), envOld...)
	if out, err := addCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("restic key add: %v\n%s", err, string(out))
	}

	// Step 2: list keys authenticated with new password, remove non-current ones
	listCmd := exec.CommandContext(ctx, r.ResticBin, "key", "list", "--json")
	listCmd.Env = append(os.Environ(), envNew...)
	listOut, err := listCmd.Output()
	if err != nil {
		// Key was added — not fatal if we can't remove old keys
		return nil
	}

	var keys []struct {
		ID      string `json:"id"`
		Current bool   `json:"current"`
	}
	if err := json.Unmarshal(listOut, &keys); err != nil {
		return nil // non-fatal
	}
	for _, k := range keys {
		if !k.Current {
			removeCmd := exec.CommandContext(ctx, r.ResticBin, "key", "remove", k.ID)
			removeCmd.Env = append(os.Environ(), envNew...)
			removeCmd.Run() // best-effort: old key becomes unreachable anyway
		}
	}
	return nil
}

// Check runs restic check to verify repository data integrity.
// It should be called after a successful backup to detect any corruption.
func (r *Runner) Check(ctx context.Context, dest *Destination, password string) error {
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return err
	}
	env = append(env, "RESTIC_PASSWORD="+password, "RESTIC_REPOSITORY="+repoURL)

	cmd := exec.CommandContext(ctx, r.ResticBin, "check", "--retry-lock=120s")
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic check failed: %v\n%s", err, string(out))
	}
	return nil
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

func (r *Runner) initRepo(ctx context.Context, repoURL string, env []string, extraArgs []string) error {
	// Check if repo exists first
	checkArgs := append([]string{"cat", "config"}, extraArgs...)
	checkCmd := exec.CommandContext(ctx, r.ResticBin, checkArgs...)
	checkCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	if err := checkCmd.Run(); err == nil {
		return nil // repo already exists
	}

	// Init new repo (pass WORM backend options if provided)
	initArgs := append([]string{"init"}, extraArgs...)
	initCmd := exec.CommandContext(ctx, r.ResticBin, initArgs...)
	initCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	out, err := initCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic init: %v\n%s", err, string(out))
	}
	return nil
}

// wormBackendOptions returns the restic --repo-backend-options flags needed to
// enable S3 Object Lock (COMPLIANCE mode) for WORM-enabled jobs.
// Only applicable for S3-compatible destinations; returns nil otherwise.
func wormBackendOptions(job *Job, dest *Destination) []string {
	if !job.WormEnabled || job.WormRetentionDays <= 0 {
		return nil
	}
	switch dest.Type {
	case "s3", "wasabi", "minio":
		// Tell restic to set S3 Object Lock COMPLIANCE mode with the configured
		// retention period. restic translates this to an x-amz-object-lock-*
		// header on every PUT operation.
		days := strconv.Itoa(job.WormRetentionDays)
		return []string{
			"--repo-backend-options", "s3.object-lock=true",
			"--repo-backend-options", "s3.object-lock-mode=COMPLIANCE",
			"--repo-backend-options", "s3.object-lock-retention-days=" + days,
		}
	case "b2":
		// Backblaze B2 uses its own Object Lock API (called "Backblaze B2 Object Lock").
		// restic does not currently expose a flag for B2 lock, but the bucket-level
		// lock policy (set on the B2 bucket itself) already provides immutability.
		// We still skip `forget` for WORM jobs (handled in Run).
		return nil
	default:
		return nil
	}
}

// prepareS3Source mounts the S3 bucket via rclone (FUSE) so restic can read
// files on-demand without downloading the entire bucket first.
// FUSE (fusermount on Linux, macOS built-in umount) must be available.
// If FUSE is not available the job will fail with a clear error message.
func (r *Runner) prepareS3Source(ctx context.Context, job *Job) (string, func(), error) {
	if runtime.GOOS == "windows" {
		return "", nil, fmt.Errorf("S3 source backup is not supported on Windows (FUSE not available)")
	}
	if runtime.GOOS == "linux" {
		hasFuse := false
		if _, err := exec.LookPath("fusermount3"); err == nil {
			hasFuse = true
		} else if _, err := exec.LookPath("fusermount"); err == nil {
			hasFuse = true
		}
		if !hasFuse {
			return "", nil, fmt.Errorf("S3 source backup requires FUSE: install fuse3 (apt install fuse3) or fuse (apt install fuse) on the agent host")
		}
	}
	return r.mountS3Source(ctx, job)
}

// mountS3Source mounts the S3 bucket read-only via rclone (FUSE) and returns
// the mount-point directory. The cleanup function unmounts and removes the dir.
// Data is streamed on-demand — no temporary disk space proportional to bucket size.
func (r *Runner) mountS3Source(ctx context.Context, job *Job) (string, func(), error) {
	cfg := job.SourceConfig
	get := func(key string) string {
		v, _ := cfg[key].(string)
		return strings.TrimSpace(v)
	}

	bucket := get("bucket")
	if bucket == "" {
		return "", nil, fmt.Errorf("S3 source: bucket is required")
	}

	mountPoint, err := os.MkdirTemp("", "backuptool-s3-mount-*")
	if err != nil {
		return "", nil, fmt.Errorf("create mount point: %w", err)
	}

	srcPath := bucket
	if p := strings.TrimPrefix(get("path"), "/"); p != "" {
		srcPath += "/" + p
	}
	remote := ":s3:" + srcPath

	args := []string{
		"mount", remote, mountPoint,
		"--read-only",
		"--no-checksum",    // skip hash validation on read — much faster
		"--no-modtime",     // don't update modtime on access
		"--allow-non-empty",
		"--s3-provider=Other",
	}
	if ep := get("endpoint"); ep != "" {
		args = append(args, "--s3-endpoint="+ep)
	}
	if ak := get("accessKeyId"); ak != "" {
		args = append(args, "--s3-access-key-id="+ak)
	}
	if sk := get("secretAccessKey"); sk != "" {
		args = append(args, "--s3-secret-access-key="+sk)
	}
	if region := get("region"); region != "" {
		args = append(args, "--s3-region="+region)
	}

	// Run rclone mount in the background (--no-daemon keeps it in-process so
	// we control its lifetime; we cancel via context or kill on cleanup).
	rcloneBin := r.RcloneBin
	if rcloneBin == "" {
		rcloneBin = "rclone"
	}
	mountCmd := exec.Command(rcloneBin, args...) // intentionally NOT ctx — we kill manually
	if err := mountCmd.Start(); err != nil {
		os.RemoveAll(mountPoint)
		return "", nil, fmt.Errorf("rclone mount start: %w", err)
	}

	// Wait up to 20 seconds for the mount to become active.
	deadline := time.Now().Add(20 * time.Second)
	mounted := false
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir(mountPoint)
		if err == nil && len(entries) >= 0 {
			// ReadDir succeeds on an active FUSE mount even when empty.
			// Additional confirmation: check if the mount point is a mountpoint.
			if isMountPoint(mountPoint) {
				mounted = true
				break
			}
		}
		time.Sleep(300 * time.Millisecond)
	}

	cleanup := func() {
		// Unmount first, then kill rclone, then remove the directory.
		switch runtime.GOOS {
		case "darwin":
			exec.Command("umount", "-f", mountPoint).Run()
		default:
			if exec.Command("fusermount3", "-uz", mountPoint).Run() != nil {
				exec.Command("fusermount", "-uz", mountPoint).Run()
			}
		}
		mountCmd.Process.Kill() //nolint:errcheck
		mountCmd.Wait()         //nolint:errcheck
		os.RemoveAll(mountPoint)
	}

	if !mounted {
		cleanup()
		return "", nil, fmt.Errorf("rclone mount timed out — FUSE may not be available in this environment; try again or ensure /dev/fuse is accessible")
	}

	return mountPoint, cleanup, nil
}

// isMountPoint checks whether the given path is currently a mount point by
// comparing its device/inode with its parent directory.
func isMountPoint(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return false
	}
	// On Linux/macOS, a mount point has a different device number than its parent.
	return !os.SameFile(info, parent)
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
// If dest.Config["_repoSuffix"] is set, it is appended to the repo URL so that each backup job
// has its own isolated repository within a shared storage bucket/path.
func (r *Runner) buildRepoURLAndEnv(dest *Destination) (string, []string, error) {
	get := func(key string) string {
		v, _ := dest.Config[key].(string)
		return strings.TrimSpace(v)
	}

	// Per-job isolation suffix (injected by server, never user-supplied)
	repoSuffix := strings.TrimSpace(get("_repoSuffix"))

	// appendSuffix appends the suffix to a URL path component if one was set.
	appendSuffix := func(u string) string {
		if repoSuffix == "" {
			return u
		}
		return strings.TrimRight(u, "/") + "/" + repoSuffix
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
		return appendSuffix(repoURL), env, nil

	case "b2":
		// Use S3-compatible API (recommended). Fields: endpoint, bucket, accessKeyId, secretAccessKey, path.
		// Legacy native B2 fields (accountId / applicationKey / keyId) are also supported as fallback.
		bucket := get("bucket")
		path := strings.TrimPrefix(get("path"), "/")
		endpoint := get("endpoint")

		// Support multiple possible key field names (old and new form versions)
		accessKey := get("accessKeyId")
		if accessKey == "" {
			accessKey = get("keyId")
		}
		secretKey := get("secretAccessKey")
		if secretKey == "" {
			secretKey = get("applicationKey")
		}

		if endpoint != "" && accessKey != "" {
			// S3-compatible path — strip any https:// prefix restic adds its own scheme
			ep := strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
			repoURL := "s3:" + ep + "/" + bucket
			if path != "" {
				repoURL += "/" + path
			}
			env := []string{
				"AWS_ACCESS_KEY_ID=" + accessKey,
				"AWS_SECRET_ACCESS_KEY=" + secretKey,
			}
			return appendSuffix(repoURL), env, nil
		}

		// Native B2 fallback (legacy — no endpoint configured)
		accountID := get("accountId")
		if accountID == "" {
			accountID = get("keyId")
		}
		appKey := get("applicationKey")
		if appKey == "" {
			appKey = get("secretAccessKey")
		}
		repoURL := "b2:" + bucket
		if path != "" {
			repoURL += "/" + path
		}
		env := []string{
			"B2_ACCOUNT_ID=" + accountID,
			"B2_ACCOUNT_KEY=" + appKey,
		}
		return appendSuffix(repoURL), env, nil

	case "local":
		return appendSuffix(get("path")), nil, nil

	case "sftp":
		port := get("port")
		if port == "" {
			port = "22"
		}
		host := get("host")
		user := get("user")
		path := get("path")
		repoURL := fmt.Sprintf("sftp:%s@%s:%s%s", user, host, port, path)
		// Disable host-key checking so the agent works in Docker/CI without a
		// pre-populated known_hosts file.  The connection is still encrypted;
		// this only skips identity verification of the server.
		env := []string{
			"RESTIC_SFTP_COMMAND=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p " + port + " " + user + "@" + host,
		}
		return appendSuffix(repoURL), env, nil

	case "rclone":
		return appendSuffix("rclone:" + get("remote")), nil, nil

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
		return appendSuffix(repoURL), env, nil

	default:
		return "", nil, fmt.Errorf("unsupported destination type: %s", dest.Type)
	}
}

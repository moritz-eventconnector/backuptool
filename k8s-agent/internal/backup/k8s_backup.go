// Package backup provides Kubernetes-aware backup logic built on top of restic.
package backup

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/backuptool/k8s-agent/internal/discovery"
)

// ---  shared types (mirrors agent/internal/backup) --------------------------

// Job represents a backup job received from the server.
type Job struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	SourcePaths     []string        `json:"sourcePaths"`
	DestinationIds  []string        `json:"destinationIds"`
	Schedule        string          `json:"schedule"`
	Retention       RetentionPolicy `json:"retention"`
	PreScript       string          `json:"preScript"`
	PostScript      string          `json:"postScript"`
	ExcludePatterns []string        `json:"excludePatterns"`
	MaxRetries      int             `json:"maxRetries"`
}

// RetentionPolicy controls how many snapshots are retained.
type RetentionPolicy struct {
	KeepLast    int `json:"keepLast"`
	KeepDaily   int `json:"keepDaily"`
	KeepWeekly  int `json:"keepWeekly"`
	KeepMonthly int `json:"keepMonthly"`
	KeepYearly  int `json:"keepYearly"`
}

// Destination represents a storage backend understood by restic.
type Destination struct {
	ID     string                 `json:"id"`
	Name   string                 `json:"name"`
	Type   string                 `json:"type"`
	Config map[string]interface{} `json:"config"`
}

// ProgressUpdate is emitted on progressCh during a backup run.
type ProgressUpdate struct {
	SnapshotID  string  `json:"snapshotId"`
	Percent     float64 `json:"percent"`
	FilesNew    int     `json:"filesNew"`
	FilesDone   int     `json:"filesDone"`
	SizeTotal   int64   `json:"sizeTotal"`
	SizeDone    int64   `json:"sizeDone"`
	CurrentFile string  `json:"currentFile"`
}

// Result is the final outcome of a backup run.
type Result struct {
	SnapshotID       string  `json:"snapshotId"`
	ResticSnapshotID string  `json:"resticSnapshotId"`
	SizeBytes        int64   `json:"sizeBytes"`
	FileCount        int     `json:"fileCount"`
	DurationSeconds  float64 `json:"durationSeconds"`
	Status           string  `json:"status"`
	ErrorMessage     string  `json:"errorMessage,omitempty"`
}

// --- K8sBackupRunner --------------------------------------------------------

// K8sBackupRunner orchestrates a Kubernetes-aware backup: it exports cluster
// resources to YAML files and optionally archives PVC data, then hands the
// resulting directory tree to restic.
type K8sBackupRunner struct {
	ResticBin  string
	KubeClient *kubernetes.Clientset
}

// Run performs a full backup for the given job and destination.
func (r *K8sBackupRunner) Run(
	ctx context.Context,
	job *Job,
	dest *Destination,
	namespace string,
	snapshotID string,
	password string,
	progressCh chan<- ProgressUpdate,
) (*Result, error) {
	start := time.Now()

	// 1. Export Kubernetes resources to a temp directory.
	exporter := &discovery.Exporter{
		Client:    r.KubeClient,
		Namespace: namespace,
	}
	exportDir, err := exporter.Export(ctx)
	if err != nil {
		return failResult(snapshotID, fmt.Errorf("export k8s resources: %w", err)), nil
	}
	defer os.RemoveAll(exportDir)

	// 2. Archive PVC data that is accessible on the local filesystem.
	if err := r.archivePVCs(ctx, exportDir, namespace); err != nil {
		// Non-fatal: the resource YAML export is more important than PVC data
		// which may not be mounted inside the agent pod.
		fmt.Fprintf(os.Stderr, "warning: PVC archive: %v\n", err)
	}

	// 3. Also include any extra source paths configured on the job.
	sourcePaths := append([]string{exportDir}, job.SourcePaths...)

	// 4. Build the restic repository URL and required environment variables.
	repoURL, env, err := r.buildRepoURLAndEnv(dest)
	if err != nil {
		return failResult(snapshotID, fmt.Errorf("build repo config: %w", err)), nil
	}
	env = append(env, "RESTIC_PASSWORD="+password)

	// 5. Ensure the restic repository is initialised.
	if err := r.initRepo(ctx, repoURL, env); err != nil {
		return failResult(snapshotID, fmt.Errorf("init repo: %w", err)), nil
	}

	// 6. Run restic backup.
	result, err := r.runRestic(ctx, job, sourcePaths, repoURL, env, snapshotID, progressCh)
	if err != nil {
		return failResult(snapshotID, err), nil
	}
	result.DurationSeconds = time.Since(start).Seconds()

	// 7. Apply retention policy (non-fatal).
	_ = r.applyRetention(ctx, job.Retention, repoURL, env)

	return result, nil
}

// archivePVCs lists PVCs in the target namespace, checks whether their data is
// mounted under /data/<pvc-name> inside the agent pod, and creates a tar.gz
// archive for each accessible PVC in exportDir.
func (r *K8sBackupRunner) archivePVCs(ctx context.Context, exportDir, namespace string) error {
	pvcs, err := r.KubeClient.CoreV1().PersistentVolumeClaims(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pvcs: %w", err)
	}

	for _, pvc := range pvcs.Items {
		// Convention: operator mounts PVC data at /data/<namespace>/<pvc-name>
		// or /data/<pvc-name>. Try both.
		candidates := []string{
			filepath.Join("/data", pvc.Namespace, pvc.Name),
			filepath.Join("/data", pvc.Name),
		}

		var mountPath string
		for _, c := range candidates {
			if info, err := os.Stat(c); err == nil && info.IsDir() {
				mountPath = c
				break
			}
		}
		if mountPath == "" {
			continue // not mounted in this pod — skip
		}

		archiveName := fmt.Sprintf("pvc-%s-%s.tar.gz", pvc.Namespace, pvc.Name)
		archivePath := filepath.Join(exportDir, archiveName)
		if err := createTarGz(archivePath, mountPath); err != nil {
			fmt.Fprintf(os.Stderr, "warning: archive PVC %s/%s: %v\n", pvc.Namespace, pvc.Name, err)
		}
	}
	return nil
}

// runRestic executes `restic backup` and streams progress updates to progressCh.
func (r *K8sBackupRunner) runRestic(
	ctx context.Context,
	job *Job,
	sourcePaths []string,
	repoURL string,
	env []string,
	snapshotID string,
	progressCh chan<- ProgressUpdate,
) (*Result, error) {
	args := []string{"backup", "--json", "--verbose"}
	for _, p := range job.ExcludePatterns {
		args = append(args, "--exclude="+p)
	}
	args = append(args, sourcePaths...)

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

	var finalSnapshotID string
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
			if id, ok := msg["snapshot_id"].(string); ok {
				finalSnapshotID = id
			}
			if sf, ok := msg["files_new"].(float64); ok {
				fileNew = int(sf)
			}
			if ss, ok := msg["total_bytes_processed"].(float64); ok {
				sizeDone = int64(ss)
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		return &Result{
			SnapshotID:   snapshotID,
			Status:       "failed",
			ErrorMessage: fmt.Sprintf("restic exited with error: %v\n%s", err, stderr.String()),
		}, nil
	}

	return &Result{
		SnapshotID:       snapshotID,
		ResticSnapshotID: finalSnapshotID,
		SizeBytes:        sizeDone,
		FileCount:        fileDone + fileNew,
		Status:           "success",
	}, nil
}

func (r *K8sBackupRunner) initRepo(ctx context.Context, repoURL string, env []string) error {
	checkCmd := exec.CommandContext(ctx, r.ResticBin, "cat", "config")
	checkCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	if err := checkCmd.Run(); err == nil {
		return nil // repo already exists
	}

	initCmd := exec.CommandContext(ctx, r.ResticBin, "init")
	initCmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	out, err := initCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic init: %v\n%s", err, string(out))
	}
	return nil
}

func (r *K8sBackupRunner) applyRetention(ctx context.Context, policy RetentionPolicy, repoURL string, env []string) error {
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
		return nil // no retention configured
	}
	cmd := exec.CommandContext(ctx, r.ResticBin, args...)
	cmd.Env = append(os.Environ(), append(env, "RESTIC_REPOSITORY="+repoURL)...)
	return cmd.Run()
}

// buildRepoURLAndEnv constructs the RESTIC_REPOSITORY value and all required
// environment variables for the given destination backend. This mirrors the
// same function in the regular agent.
func (r *K8sBackupRunner) buildRepoURLAndEnv(dest *Destination) (string, []string, error) {
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
		repoURL := fmt.Sprintf("sftp:%s@%s:%s%s", get("user"), get("host"), port, get("path"))
		return repoURL, nil, nil

	case "rclone":
		return "rclone:" + get("remote"), nil, nil

	case "gcs":
		bucket := get("bucket")
		path := strings.TrimPrefix(get("path"), "/")
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

// --- helpers ----------------------------------------------------------------

func failResult(snapshotID string, err error) *Result {
	return &Result{
		SnapshotID:   snapshotID,
		Status:       "failed",
		ErrorMessage: err.Error(),
	}
}

// createTarGz archives the directory at srcDir into a gzip-compressed tar at
// dstPath.
func createTarGz(dstPath, srcDir string) error {
	f, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	defer gz.Close()

	tw := tar.NewWriter(gz)
	defer tw.Close()

	return filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}

		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = relPath

		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}

		if info.IsDir() {
			return nil
		}

		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer src.Close()

		_, err = io.Copy(tw, src)
		return err
	})
}

// Package discovery exports Kubernetes resources to YAML files for inclusion
// in a restic backup.
package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Exporter discovers Kubernetes resources and serialises them to YAML files.
type Exporter struct {
	Client    *kubernetes.Clientset
	Namespace string // empty == all namespaces
}

// Export writes one YAML file per resource type under a newly created temp
// directory and returns the directory path. The caller is responsible for
// removing the directory when it is no longer needed.
func (e *Exporter) Export(ctx context.Context) (string, error) {
	dir, err := os.MkdirTemp("", "backuptool-k8s-*")
	if err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}

	exportFns := []func(context.Context, string) error{
		e.exportDeployments,
		e.exportStatefulSets,
		e.exportDaemonSets,
		e.exportServices,
		e.exportConfigMaps,
		e.exportSecrets,
		e.exportPersistentVolumeClaims,
		e.exportIngresses,
		e.exportHorizontalPodAutoscalers,
		e.exportCronJobs,
	}

	for _, fn := range exportFns {
		if err := fn(ctx, dir); err != nil {
			// Non-fatal: log and continue so a single failing resource type
			// does not abort the entire backup.
			fmt.Fprintf(os.Stderr, "warning: resource export error: %v\n", err)
		}
	}

	return dir, nil
}

// --- resource-specific exporters -------------------------------------------

func (e *Exporter) exportDeployments(ctx context.Context, dir string) error {
	list, err := e.Client.AppsV1().Deployments(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list deployments: %w", err)
	}
	return writeYAML(dir, "deployments.yaml", list)
}

func (e *Exporter) exportStatefulSets(ctx context.Context, dir string) error {
	list, err := e.Client.AppsV1().StatefulSets(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list statefulsets: %w", err)
	}
	return writeYAML(dir, "statefulsets.yaml", list)
}

func (e *Exporter) exportDaemonSets(ctx context.Context, dir string) error {
	list, err := e.Client.AppsV1().DaemonSets(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list daemonsets: %w", err)
	}
	return writeYAML(dir, "daemonsets.yaml", list)
}

func (e *Exporter) exportServices(ctx context.Context, dir string) error {
	list, err := e.Client.CoreV1().Services(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list services: %w", err)
	}
	return writeYAML(dir, "services.yaml", list)
}

func (e *Exporter) exportConfigMaps(ctx context.Context, dir string) error {
	list, err := e.Client.CoreV1().ConfigMaps(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list configmaps: %w", err)
	}
	return writeYAML(dir, "configmaps.yaml", list)
}

func (e *Exporter) exportSecrets(ctx context.Context, dir string) error {
	list, err := e.Client.CoreV1().Secrets(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list secrets: %w", err)
	}
	return writeYAML(dir, "secrets.yaml", list)
}

func (e *Exporter) exportPersistentVolumeClaims(ctx context.Context, dir string) error {
	list, err := e.Client.CoreV1().PersistentVolumeClaims(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pvcs: %w", err)
	}
	return writeYAML(dir, "persistentvolumeclaims.yaml", list)
}

func (e *Exporter) exportIngresses(ctx context.Context, dir string) error {
	list, err := e.Client.NetworkingV1().Ingresses(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list ingresses: %w", err)
	}
	return writeYAML(dir, "ingresses.yaml", list)
}

func (e *Exporter) exportHorizontalPodAutoscalers(ctx context.Context, dir string) error {
	list, err := e.Client.AutoscalingV2().HorizontalPodAutoscalers(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list hpas: %w", err)
	}
	return writeYAML(dir, "horizontalpodautoscalers.yaml", list)
}

func (e *Exporter) exportCronJobs(ctx context.Context, dir string) error {
	list, err := e.Client.BatchV1().CronJobs(e.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list cronjobs: %w", err)
	}
	return writeYAML(dir, "cronjobs.yaml", list)
}

// --- helpers ----------------------------------------------------------------

// writeYAML serialises obj (a Kubernetes list object) via JSON → YAML and
// writes it to dir/filename. We round-trip through JSON so that the standard
// json struct tags on the k8s types are honoured.
func writeYAML(dir, filename string, obj interface{}) error {
	jsonBytes, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("marshal %s to JSON: %w", filename, err)
	}

	// Unmarshal into a generic structure so yaml.Marshal can re-encode it.
	var generic interface{}
	if err := json.Unmarshal(jsonBytes, &generic); err != nil {
		return fmt.Errorf("unmarshal %s from JSON: %w", filename, err)
	}

	yamlBytes, err := yaml.Marshal(generic)
	if err != nil {
		return fmt.Errorf("marshal %s to YAML: %w", filename, err)
	}

	return os.WriteFile(filepath.Join(dir, filename), yamlBytes, 0600)
}

package config

import (
	"os"
	"path/filepath"
)

// Config holds all configuration for the Kubernetes backup agent, loaded from
// environment variables. Cert/key fields are populated after registration and
// persisted to DATA_DIR for use in subsequent runs.
type Config struct {
	// ServerURL is the base URL of the BackupTool server (e.g. https://backup.example.com).
	ServerURL string

	// AgentID is the stable identifier assigned to this agent on the server.
	AgentID string

	// Token is the one-time registration token. It is cleared after a successful
	// registration and the resulting mTLS credentials are stored instead.
	Token string

	// ApiToken is the persistent authentication token for WebSocket and internal
	// API calls. Received during registration, persisted to disk.
	ApiToken string

	// mTLS credentials received from the server after registration.
	CertPEM   string
	KeyPEM    string
	CACertPEM string

	// ResticBin is the path to the restic binary (default: "restic").
	ResticBin string

	// BackupNamespace restricts resource discovery to a single namespace.
	// An empty value means all namespaces are backed up.
	BackupNamespace string

	// DataDir is the local directory used to store the agent config, certs, and
	// temporary backup artefacts.
	DataDir string
}

// Load reads the configuration from environment variables and returns a Config.
// Fields that are not set fall back to their defaults.
func Load() *Config {
	return &Config{
		ServerURL:       requireEnv("SERVER_URL"),
		AgentID:         requireEnv("AGENT_ID"),
		Token:           os.Getenv("AGENT_TOKEN"),
		ResticBin:       envOr("RESTIC_BIN", "restic"),
		BackupNamespace: os.Getenv("BACKUP_NAMESPACE"),
		DataDir:         envOr("DATA_DIR", "/data/backuptool"),
		// mTLS certs may be pre-populated via env if the operator injects them,
		// otherwise they are populated during registration and persisted to disk.
		CertPEM:   os.Getenv("CERT_FILE"),
		KeyPEM:    os.Getenv("KEY_FILE"),
		CACertPEM: os.Getenv("CA_FILE"),
	}
}

// IsRegistered reports whether the agent holds valid mTLS credentials.
func (c *Config) IsRegistered() bool {
	return c.CertPEM != "" && c.KeyPEM != ""
}

// CertPath returns the path where the client certificate is persisted.
func (c *Config) CertPath() string { return filepath.Join(c.DataDir, "agent.crt") }

// KeyPath returns the path where the client private key is persisted.
func (c *Config) KeyPath() string { return filepath.Join(c.DataDir, "agent.key") }

// CAPath returns the path where the server CA certificate is persisted.
func (c *Config) CAPath() string { return filepath.Join(c.DataDir, "ca.crt") }

// TokenPath returns the path where the API token is persisted.
func (c *Config) TokenPath() string { return filepath.Join(c.DataDir, "api.token") }

// SaveCerts writes the mTLS credentials and API token to DATA_DIR so they survive pod restarts.
func (c *Config) SaveCerts() error {
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(c.CertPath(), []byte(c.CertPEM), 0600); err != nil {
		return err
	}
	if err := os.WriteFile(c.KeyPath(), []byte(c.KeyPEM), 0600); err != nil {
		return err
	}
	if c.CACertPEM != "" {
		if err := os.WriteFile(c.CAPath(), []byte(c.CACertPEM), 0600); err != nil {
			return err
		}
	}
	if c.ApiToken != "" {
		if err := os.WriteFile(c.TokenPath(), []byte(c.ApiToken), 0600); err != nil {
			return err
		}
	}
	return nil
}

// LoadCerts tries to read previously persisted mTLS credentials and API token from DATA_DIR.
// It silently returns if the files do not exist yet.
func (c *Config) LoadCerts() {
	if c.IsRegistered() {
		return // already in-memory (e.g. from env)
	}
	cert, err := os.ReadFile(c.CertPath())
	if err != nil {
		return
	}
	key, err := os.ReadFile(c.KeyPath())
	if err != nil {
		return
	}
	c.CertPEM = string(cert)
	c.KeyPEM = string(key)
	if ca, err := os.ReadFile(c.CAPath()); err == nil {
		c.CACertPEM = string(ca)
	}
	if tok, err := os.ReadFile(c.TokenPath()); err == nil {
		c.ApiToken = string(tok)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func requireEnv(key string) string {
	return os.Getenv(key) // callers validate non-empty at startup
}

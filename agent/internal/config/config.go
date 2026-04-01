package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	ServerURL   string `yaml:"server_url"`
	AgentID     string `yaml:"agent_id"`
	Token       string `yaml:"token"`        // registration token (cleared after registration)
	ApiToken    string `yaml:"api_token"`    // persistent auth token (received after registration)
	CertPEM     string `yaml:"cert_pem"`     // mTLS client cert
	KeyPEM      string `yaml:"key_pem"`      // mTLS client private key
	CACertPEM   string `yaml:"ca_cert_pem"`  // server CA cert for verification
	DataDir     string `yaml:"data_dir"`
	ResticBin   string `yaml:"restic_bin"`
	RcloneBin   string `yaml:"rclone_bin"`
	LogLevel    string `yaml:"log_level"`
}

func DefaultConfig() Config {
	return Config{
		DataDir:   defaultDataDir(),
		ResticBin: "restic",
		RcloneBin: "rclone",
		LogLevel:  "info",
	}
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg := DefaultConfig()
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &cfg, nil
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func (c *Config) IsRegistered() bool {
	return c.AgentID != "" && c.CertPEM != "" && c.KeyPEM != ""
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/var/lib/backuptool-agent"
	}
	return filepath.Join(home, ".backuptool-agent")
}

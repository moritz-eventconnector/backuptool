package client

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// ServerClient handles communication with the BackupTool server.
type ServerClient struct {
	ServerURL string
	AgentID   string
	ApiToken  string
	httpCli   *http.Client
}

// NewServerClient creates a client with mTLS configured.
func NewServerClient(serverURL, agentID, apiToken, certPEM, keyPEM, caCertPEM string) (*ServerClient, error) {
	var tlsCfg *tls.Config

	if certPEM != "" && keyPEM != "" {
		cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
		if err != nil {
			return nil, fmt.Errorf("load client cert: %w", err)
		}

		rootCAs := x509.NewCertPool()
		if caCertPEM != "" {
			if !rootCAs.AppendCertsFromPEM([]byte(caCertPEM)) {
				return nil, fmt.Errorf("failed to append CA cert")
			}
		}

		tlsCfg = &tls.Config{
			Certificates: []tls.Certificate{cert},
			RootCAs:      rootCAs,
			MinVersion:   tls.VersionTLS13,
		}
	}

	transport := &http.Transport{
		TLSClientConfig: tlsCfg,
	}

	return &ServerClient{
		ServerURL: serverURL,
		AgentID:   agentID,
		ApiToken:  apiToken,
		httpCli: &http.Client{
			Timeout:   60 * time.Second,
			Transport: transport,
		},
	}, nil
}

// RegistrationRequest is sent by the agent when registering.
type RegistrationRequest struct {
	AgentID           string   `json:"agentId"`
	RegistrationToken string   `json:"registrationToken"`
	Name              string   `json:"name"`
	OS                string   `json:"os"`
	Arch              string   `json:"arch"`
	Hostname          string   `json:"hostname"`
	Version           string   `json:"version"`
	Tags              []string `json:"tags"`
}

// RegistrationResponse contains the mTLS certificates and API token.
type RegistrationResponse struct {
	AgentID  string `json:"agentId"`
	CertPEM  string `json:"certPem"`
	KeyPEM   string `json:"keyPem"`
	CACert   string `json:"caCert"`
	ApiToken string `json:"apiToken"` // persistent auth token for WS + internal API
}

// JobConfig is a job with decrypted destination configs and restic password.
type JobConfig struct {
	ID                string                 `json:"id"`
	Name              string                 `json:"name"`
	SourcePaths       []string               `json:"sourcePaths"`
	DestinationIDs    []string               `json:"destinationIds"`
	Schedule          string                 `json:"schedule"`
	Retention         map[string]interface{} `json:"retention"`
	PreScript         string                 `json:"preScript"`
	PostScript        string                 `json:"postScript"`
	ExcludePatterns   []string               `json:"excludePatterns"`
	MaxRetries        int                    `json:"maxRetries"`
	RetryDelaySeconds int                    `json:"retryDelaySeconds"`
	Enabled           bool                   `json:"enabled"`
	Destinations      []DestinationConfig    `json:"destinations"`
	ResticPassword    string                 `json:"resticPassword"`
	WormEnabled       bool                   `json:"wormEnabled"`
	WormRetentionDays int                    `json:"wormRetentionDays"`
}

// DestinationConfig is a decrypted destination config from the server.
type DestinationConfig struct {
	ID     string                 `json:"id"`
	Name   string                 `json:"name"`
	Type   string                 `json:"type"`
	Config map[string]interface{} `json:"config"`
}

func (c *ServerClient) Register(req RegistrationRequest) (*RegistrationResponse, error) {
	body, _ := json.Marshal(req)
	resp, err := c.httpCli.Post(c.ServerURL+"/api/agents/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("register request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("registration failed (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result RegistrationResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode registration response: %w", err)
	}
	return &result, nil
}

// GetJobConfig fetches a single job config with decrypted destination and Restic password.
func (c *ServerClient) GetJobConfig(jobID string) (*JobConfig, error) {
	req, err := http.NewRequest("GET", c.ServerURL+"/api/internal/agents/"+c.AgentID+"/jobs/"+jobID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.ApiToken)
	req.Header.Set("X-Agent-ID", c.AgentID)

	resp, err := c.httpCli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("get job config failed (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var job JobConfig
	if err := json.NewDecoder(resp.Body).Decode(&job); err != nil {
		return nil, err
	}
	return &job, nil
}

// GetJobConfigs fetches all jobs with decrypted destination configs from the internal API.
func (c *ServerClient) GetJobConfigs() ([]JobConfig, error) {
	req, err := http.NewRequest("GET", c.ServerURL+"/api/internal/agents/"+c.AgentID+"/jobs", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.ApiToken)
	req.Header.Set("X-Agent-ID", c.AgentID)

	resp, err := c.httpCli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("get job configs failed (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var jobs []JobConfig
	if err := json.NewDecoder(resp.Body).Decode(&jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

// ConnectWebSocket establishes a WebSocket connection and authenticates as an agent.
func (c *ServerClient) ConnectWebSocket() (*websocket.Conn, error) {
	wsURL := c.ServerURL + "/ws"
	// Convert http(s) to ws(s)
	if len(wsURL) >= 5 && wsURL[:5] == "https" {
		wsURL = "wss" + wsURL[5:]
	} else if len(wsURL) >= 4 && wsURL[:4] == "http" {
		wsURL = "ws" + wsURL[4:]
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  c.httpCli.Transport.(*http.Transport).TLSClientConfig,
		HandshakeTimeout: 15 * time.Second,
	}

	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("websocket dial: %w", err)
	}

	// Identify as agent using persistent API token
	msg := map[string]interface{}{
		"type":    "agent_connect",
		"agentId": c.AgentID,
		"token":   c.ApiToken,
	}
	if err := conn.WriteJSON(msg); err != nil {
		conn.Close()
		return nil, fmt.Errorf("send agent_connect: %w", err)
	}

	return conn, nil
}

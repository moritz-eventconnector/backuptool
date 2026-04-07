package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"

	// embed requires a blank import when only the directive is used.
	_ "embed"

	"github.com/backuptool/licenser/internal/license"
	"github.com/backuptool/licenser/internal/store"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/cobra"

	"crypto/subtle"
	"os"
)

//go:embed ui/index.html
var indexHTML string

func serveCmd() *cobra.Command {
	var (
		port           int
		username       string
		password       string
		privateKeyPath string
		publicKeyPath  string
		dataDir        string
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the license management web UI",
		Long:  `Starts a password-protected web interface for generating and verifying licenses.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			privPEM, err := os.ReadFile(privateKeyPath)
			if err != nil {
				return fmt.Errorf("read private key: %w", err)
			}
			pubPEM, err := os.ReadFile(publicKeyPath)
			if err != nil {
				return fmt.Errorf("read public key: %w", err)
			}

			pubKeyB64 := derivePublicKeyBase64url(pubPEM)

			st, err := store.New(dataDir)
			if err != nil {
				return fmt.Errorf("open store: %w", err)
			}

			srv := &server{
				privPEM:  privPEM,
				pubPEM:   pubPEM,
				pubKeyB64: pubKeyB64,
				store:    st,
				username: username,
				password: password,
			}

			mux := http.NewServeMux()
			mux.HandleFunc("/", srv.handleIndex)
			mux.HandleFunc("/api/status", srv.handleStatus)
			mux.HandleFunc("/api/licenses", srv.handleLicenses)
			mux.HandleFunc("/api/licenses/", srv.handleLicense)
			mux.HandleFunc("/api/verify", srv.handleVerify)

			handler := srv.basicAuth(mux)
			addr := fmt.Sprintf(":%d", port)
			fmt.Printf("Licenser UI running on http://localhost%s (user: %s)\n", addr, username)
			return http.ListenAndServe(addr, handler)
		},
	}

	cmd.Flags().IntVar(&port, "port", 8181, "Port to listen on")
	cmd.Flags().StringVar(&username, "username", "admin", "Basic auth username")
	cmd.Flags().StringVar(&password, "password", "", "Basic auth password (required)")
	cmd.Flags().StringVar(&privateKeyPath, "private-key", "./private.pem", "Path to Ed25519 private key")
	cmd.Flags().StringVar(&publicKeyPath, "public-key", "./public.pem", "Path to Ed25519 public key")
	cmd.Flags().StringVar(&dataDir, "data-dir", "./data", "Directory to store licenses.json")
	_ = cmd.MarkFlagRequired("password")

	return cmd
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
	privPEM   []byte
	pubPEM    []byte
	pubKeyB64 string
	store     *store.Store
	username  string
	password  string
}

// ---------------------------------------------------------------------------
// Basic Auth middleware
// ---------------------------------------------------------------------------

func (s *server) basicAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(s.username)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(s.password)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Licenser"`)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /
func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	authHeader := base64.StdEncoding.EncodeToString(
		[]byte(s.username + ":" + s.password),
	)

	type tmplData struct {
		AuthHeader string
	}

	tmpl, err := template.New("index").Parse(indexHTML)
	if err != nil {
		http.Error(w, "template error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.Execute(w, tmplData{AuthHeader: authHeader}); err != nil {
		// Headers already written; nothing more to do.
		_ = err
	}
}

// GET /api/status
func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"publicKeyB64": s.pubKeyB64,
		"stats":        s.store.Stats(),
	})
}

// GET /api/licenses  →  list (rawJwt omitted)
// POST /api/licenses →  create
func (s *server) handleLicenses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listLicenses(w, r)
	case http.MethodPost:
		s.createLicense(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *server) listLicenses(w http.ResponseWriter, r *http.Request) {
	all := s.store.List()
	// Strip rawJwt for the list endpoint.
	type publicRecord struct {
		ID           string   `json:"id"`
		CustomerID   string   `json:"customerId"`
		CustomerName string   `json:"customerName"`
		Edition      string   `json:"edition"`
		Seats        int      `json:"seats"`
		Features     []string `json:"features"`
		Fingerprint  string   `json:"fingerprint,omitempty"`
		ExpiresAt    string   `json:"expiresAt,omitempty"`
		Notes        string   `json:"notes,omitempty"`
		Revoked      bool     `json:"revoked"`
		RevokedAt    string   `json:"revokedAt,omitempty"`
		CreatedAt    string   `json:"createdAt"`
	}
	out := make([]publicRecord, len(all))
	for i, r := range all {
		out[i] = publicRecord{
			ID:           r.ID,
			CustomerID:   r.CustomerID,
			CustomerName: r.CustomerName,
			Edition:      r.Edition,
			Seats:        r.Seats,
			Features:     r.Features,
			Fingerprint:  r.Fingerprint,
			ExpiresAt:    r.ExpiresAt,
			Notes:        r.Notes,
			Revoked:      r.Revoked,
			RevokedAt:    r.RevokedAt,
			CreatedAt:    r.CreatedAt,
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type createLicenseRequest struct {
	CustomerID   string   `json:"customerId"`
	CustomerName string   `json:"customerName"`
	Edition      string   `json:"edition"`
	Seats        int      `json:"seats"`
	Features     []string `json:"features"`
	Expiry       string   `json:"expiry"`
	Fingerprint  string   `json:"fingerprint"`
	Notes        string   `json:"notes"`
}

func (s *server) createLicense(w http.ResponseWriter, r *http.Request) {
	var req createLicenseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	switch req.Edition {
	case "community", "pro", "enterprise":
	default:
		writeError(w, http.StatusBadRequest, `edition must be one of: community, pro, enterprise`)
		return
	}

	if req.Seats <= 0 {
		req.Seats = 5
	}

	var expiry *jwt.NumericDate
	var expiresAtStr string
	if req.Expiry != "" {
		t, err := time.Parse("2006-01-02", req.Expiry)
		if err != nil {
			writeError(w, http.StatusBadRequest, "expiry must be in YYYY-MM-DD format")
			return
		}
		t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, time.UTC)
		expiry = jwt.NewNumericDate(t)
		expiresAtStr = t.Format(time.RFC3339)
	}

	claims := license.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   req.CustomerID,
			Issuer:    "backuptool",
			IssuedAt:  jwt.NewNumericDate(time.Now().UTC()),
			ExpiresAt: expiry,
		},
		Edition:      license.Edition(req.Edition),
		Seats:        req.Seats,
		Features:     req.Features,
		CustomerName: req.CustomerName,
		Fingerprint:  req.Fingerprint,
	}

	if claims.Features == nil {
		claims.Features = []string{}
	}

	rawJWT, err := license.Generate(s.privPEM, claims)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate license: "+err.Error())
		return
	}

	id, err := store.GenerateID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate id: "+err.Error())
		return
	}

	rec := store.LicenseRecord{
		ID:           id,
		CustomerID:   req.CustomerID,
		CustomerName: req.CustomerName,
		Edition:      req.Edition,
		Seats:        req.Seats,
		Features:     req.Features,
		Fingerprint:  req.Fingerprint,
		RawJWT:       rawJWT,
		ExpiresAt:    expiresAtStr,
		Notes:        req.Notes,
		Revoked:      false,
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	}

	if rec.Features == nil {
		rec.Features = []string{}
	}

	if err := s.store.Add(rec); err != nil {
		writeError(w, http.StatusInternalServerError, "save license: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, rec)
}

// GET    /api/licenses/:id  →  full record including rawJwt
// DELETE /api/licenses/:id  →  revoke
func (s *server) handleLicense(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/licenses/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing license id")
		return
	}

	switch r.Method {
	case http.MethodGet:
		rec, ok := s.store.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "license not found")
			return
		}
		writeJSON(w, http.StatusOK, rec)

	case http.MethodDelete:
		if err := s.store.Revoke(id); err != nil {
			if strings.Contains(err.Error(), "not found") {
				writeError(w, http.StatusNotFound, err.Error())
			} else {
				writeError(w, http.StatusBadRequest, err.Error())
			}
			return
		}
		rec, _ := s.store.Get(id)
		writeJSON(w, http.StatusOK, rec)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// POST /api/verify
type verifyRequest struct {
	JWT string `json:"jwt"`
}

func (s *server) handleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req verifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	claims, err := license.Verify(strings.TrimSpace(req.JWT), s.pubPEM)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"valid": false,
			"error": err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"valid":  true,
		"claims": claims,
	})
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// ---------------------------------------------------------------------------
// Public key helper (kept from old serve.go)
// ---------------------------------------------------------------------------

func derivePublicKeyBase64url(pubPEM []byte) string {
	der := pemBodyBytes(pubPEM)
	if len(der) < 32 {
		return "(error: key too short)"
	}
	raw := der[len(der)-32:]
	return base64.RawURLEncoding.EncodeToString(raw)
}

func pemBodyBytes(pemData []byte) []byte {
	s := string(pemData)
	lines := strings.Split(s, "\n")
	var b64 strings.Builder
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "-----") {
			continue
		}
		b64.WriteString(l)
	}
	decoded, _ := base64.StdEncoding.DecodeString(b64.String())
	return decoded
}

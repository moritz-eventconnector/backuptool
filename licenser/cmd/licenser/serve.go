package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/backuptool/licenser/internal/license"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/cobra"
)

func serveCmd() *cobra.Command {
	var (
		port           string
		username       string
		password       string
		privateKeyPath string
		publicKeyPath  string
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

			// Derive base64url public key for display (strip PEM header, decode DER, take last 32 bytes = raw Ed25519)
			pubKeyDisplay := derivePublicKeyBase64url(pubPEM)

			mux := http.NewServeMux()
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				handleIndex(w, r, privPEM, pubPEM, pubKeyDisplay)
			})

			handler := basicAuth(username, password, mux)
			addr := ":" + port
			fmt.Printf("Licenser UI running on http://localhost%s (user: %s)\n", addr, username)
			return http.ListenAndServe(addr, handler)
		},
	}

	cmd.Flags().StringVar(&port, "port", "8181", "Port to listen on")
	cmd.Flags().StringVar(&username, "username", "admin", "Basic auth username")
	cmd.Flags().StringVar(&password, "password", "", "Basic auth password (required)")
	cmd.Flags().StringVar(&privateKeyPath, "private-key", "./private.pem", "Path to Ed25519 private key")
	cmd.Flags().StringVar(&publicKeyPath, "public-key", "./public.pem", "Path to Ed25519 public key")
	_ = cmd.MarkFlagRequired("password")

	return cmd
}

// ── Basic Auth middleware ─────────────────────────────────────────────────────

func basicAuth(user, pass string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(user)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Licenser"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Request handler ───────────────────────────────────────────────────────────

type pageData struct {
	PublicKeyB64 string
	Result       string
	Error        string
	Claims       *license.Claims
	Tab          string // "generate" | "verify"
}

func handleIndex(w http.ResponseWriter, r *http.Request, privPEM, pubPEM []byte, pubKeyB64 string) {
	data := pageData{PublicKeyB64: pubKeyB64, Tab: "generate"}

	if r.Method == http.MethodPost {
		r.ParseForm()
		action := r.FormValue("action")
		data.Tab = action

		switch action {
		case "generate":
			token, claims, err := generateFromForm(r, privPEM)
			if err != nil {
				data.Error = err.Error()
			} else {
				data.Result = token
				data.Claims = claims
			}
		case "verify":
			tokenStr := strings.TrimSpace(r.FormValue("token"))
			claims, err := license.Verify(tokenStr, pubPEM)
			if err != nil {
				data.Error = "Verification failed: " + err.Error()
			} else {
				data.Claims = claims
				data.Result = "valid"
			}
		}
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := uiTemplate.Execute(w, data); err != nil {
		http.Error(w, err.Error(), 500)
	}
}

func generateFromForm(r *http.Request, privPEM []byte) (string, *license.Claims, error) {
	edition := r.FormValue("edition")
	switch edition {
	case "community", "pro", "enterprise":
	default:
		return "", nil, fmt.Errorf("invalid edition %q", edition)
	}

	seats, _ := strconv.Atoi(r.FormValue("seats"))
	if seats <= 0 {
		seats = 5
	}

	var features []string
	for _, f := range strings.Split(r.FormValue("features"), ",") {
		f = strings.TrimSpace(f)
		if f != "" {
			features = append(features, f)
		}
	}

	var expiry *jwt.NumericDate
	if exp := r.FormValue("expiry"); exp != "" {
		t, err := time.Parse("2006-01-02", exp)
		if err != nil {
			return "", nil, fmt.Errorf("expiry must be YYYY-MM-DD: %w", err)
		}
		t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, time.UTC)
		expiry = jwt.NewNumericDate(t)
	}

	claims := license.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   r.FormValue("customer_id"),
			Issuer:    "backuptool",
			IssuedAt:  jwt.NewNumericDate(time.Now().UTC()),
			ExpiresAt: expiry,
		},
		Edition:      license.Edition(edition),
		Seats:        seats,
		Features:     features,
		CustomerName: r.FormValue("customer_name"),
		Fingerprint:  r.FormValue("fingerprint"),
	}

	token, err := license.Generate(privPEM, claims)
	if err != nil {
		return "", nil, err
	}
	return token, &claims, nil
}

// ── Public key helper ─────────────────────────────────────────────────────────

// derivePublicKeyBase64url extracts the raw 32-byte Ed25519 public key from a
// PKIX PEM and returns it base64url-encoded (the format expected by the server).
func derivePublicKeyBase64url(pubPEM []byte) string {
	// Quick hack: PKIX-encoded Ed25519 public key = 12-byte header + 32-byte key
	// So we just base64-decode the PEM body and take the last 32 bytes.
	// Proper approach would use x509.ParsePKIXPublicKey, but that requires importing crypto/x509 here.
	pubJSON, _ := json.Marshal(string(pubPEM))
	_ = pubJSON
	// Use raw DER approach
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

// ── HTML template ─────────────────────────────────────────────────────────────

var uiTemplate = template.Must(template.New("ui").Funcs(template.FuncMap{
	"fmtTime": func(t *jwt.NumericDate) string {
		if t == nil {
			return "perpetual"
		}
		return t.Time.UTC().Format("2006-01-02")
	},
	"join": strings.Join,
}).Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BackupTool Licenser</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:32px 24px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:20px;font-weight:700;margin-bottom:4px;color:#fff}
.sub{color:#64748b;font-size:13px;margin-bottom:28px}
.tabs{display:flex;gap:2px;border-bottom:1px solid #1e293b;margin-bottom:24px}
.tab{padding:8px 16px;background:none;border:none;color:#64748b;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;transition:.15s}
.tab.active{color:#6366f1;border-bottom-color:#6366f1;font-weight:600}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:24px;margin-bottom:20px}
label{display:block;font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
input,select,textarea{width:100%;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 12px;color:#e2e8f0;font-size:13px;outline:none;transition:.15s}
input:focus,select:focus,textarea:focus{border-color:#6366f1}
textarea{font-family:monospace;resize:vertical}
.grid{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.fg{margin-bottom:14px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:.15s}
.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}
.alert{border-radius:6px;padding:12px 14px;font-size:13px;margin-bottom:16px}
.alert-err{background:#450a0a;border:1px solid #991b1b;color:#fca5a5}
.alert-ok{background:#052e16;border:1px solid #166534;color:#86efac}
.token-box{background:#0a0c12;border:1px solid #1e293b;border-radius:6px;padding:14px;font-family:monospace;font-size:11px;word-break:break-all;color:#a5f3fc;margin-bottom:12px}
.copy-btn{width:100%;background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:8px;font-size:12px;cursor:pointer}
.copy-btn:hover{border-color:#6366f1;color:#6366f1}
.claim-table{width:100%;border-collapse:collapse;font-size:13px}
.claim-table td{padding:6px 10px;border-bottom:1px solid #1e293b}
.claim-table td:first-child{color:#64748b;width:140px}
.pubkey-box{background:#0a0c12;border:1px solid #1e293b;border-radius:6px;padding:12px;font-family:monospace;font-size:11px;word-break:break-all;color:#fbbf24;margin-bottom:8px}
small{color:#64748b;font-size:11px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🔑 BackupTool Licenser</h1>
  <p class="sub">Vendor license management — keep this tool private</p>

  <div class="card">
    <label>Public Key (base64url) — embed in server/src/licensing/verifier.ts</label>
    <div class="pubkey-box">{{.PublicKeyB64}}</div>
    <small>Replace VENDOR_PUBLIC_KEY in verifier.ts with the value above</small>
  </div>

  <div class="tabs">
    <button class="tab {{if eq .Tab "generate"}}active{{end}}" onclick="showTab('generate')">Generate License</button>
    <button class="tab {{if eq .Tab "verify"}}active{{end}}" onclick="showTab('verify')">Verify License</button>
  </div>

  {{if .Error}}<div class="alert alert-err">{{.Error}}</div>{{end}}

  <!-- Generate Tab -->
  <div id="tab-generate" style="{{if ne .Tab "generate"}}display:none{{end}}">
    {{if and .Result (eq .Tab "generate")}}
    <div class="card">
      <div class="alert alert-ok" style="margin-bottom:14px">License generated successfully</div>
      <label>License JWT — send this to the customer</label>
      <div class="token-box" id="token">{{.Result}}</div>
      <button class="copy-btn" onclick="copyToken()">Copy to clipboard</button>
      {{if .Claims}}
      <table class="claim-table" style="margin-top:16px">
        <tr><td>Customer</td><td>{{.Claims.CustomerName}} ({{.Claims.Subject}})</td></tr>
        <tr><td>Edition</td><td>{{.Claims.Edition}}</td></tr>
        <tr><td>Seats</td><td>{{.Claims.Seats}}</td></tr>
        <tr><td>Features</td><td>{{join .Claims.Features ", "}}</td></tr>
        <tr><td>Issued</td><td>{{fmtTime .Claims.IssuedAt}}</td></tr>
        <tr><td>Expires</td><td>{{fmtTime .Claims.ExpiresAt}}</td></tr>
      </table>
      {{end}}
    </div>
    {{end}}
    <div class="card">
      <form method="POST">
        <input type="hidden" name="action" value="generate"/>
        <div class="grid">
          <div class="fg"><label>Customer ID</label><input name="customer_id" placeholder="acme-corp" required/></div>
          <div class="fg"><label>Customer Name</label><input name="customer_name" placeholder="ACME Corp"/></div>
        </div>
        <div class="grid">
          <div class="fg">
            <label>Edition</label>
            <select name="edition">
              <option value="community">Community</option>
              <option value="pro" selected>Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div class="fg"><label>Seats</label><input name="seats" type="number" value="5" min="1"/></div>
        </div>
        <div class="grid">
          <div class="fg"><label>Expiry (YYYY-MM-DD, leave empty = perpetual)</label><input name="expiry" type="date"/></div>
          <div class="fg"><label>Fingerprint (optional)</label><input name="fingerprint" placeholder="sha256:..."/></div>
        </div>
        <div class="fg"><label>Features (comma-separated)</label><input name="features" placeholder="sso,audit_log,k8s_agent"/></div>
        <button type="submit" class="btn btn-primary">Generate License</button>
      </form>
    </div>
  </div>

  <!-- Verify Tab -->
  <div id="tab-verify" style="{{if ne .Tab "verify"}}display:none{{end}}">
    {{if and .Claims (eq .Tab "verify")}}
    <div class="card">
      <div class="alert alert-ok" style="margin-bottom:14px">License is VALID</div>
      <table class="claim-table">
        <tr><td>Customer</td><td>{{.Claims.CustomerName}} ({{.Claims.Subject}})</td></tr>
        <tr><td>Edition</td><td>{{.Claims.Edition}}</td></tr>
        <tr><td>Seats</td><td>{{.Claims.Seats}}</td></tr>
        <tr><td>Features</td><td>{{join .Claims.Features ", "}}</td></tr>
        <tr><td>Issued</td><td>{{fmtTime .Claims.IssuedAt}}</td></tr>
        <tr><td>Expires</td><td>{{fmtTime .Claims.ExpiresAt}}</td></tr>
      </table>
    </div>
    {{end}}
    <div class="card">
      <form method="POST">
        <input type="hidden" name="action" value="verify"/>
        <div class="fg"><label>License JWT</label><textarea name="token" rows="5" placeholder="Paste license JWT here…"></textarea></div>
        <button type="submit" class="btn btn-primary">Verify</button>
      </form>
    </div>
  </div>
</div>

<script>
function showTab(t){
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('[id^="tab-"]').forEach(d=>d.style.display='none');
  event.target.classList.add('active');
  document.getElementById('tab-'+t).style.display='';
}
function copyToken(){
  navigator.clipboard.writeText(document.getElementById('token').innerText);
  event.target.innerText='Copied!';
  setTimeout(()=>event.target.innerText='Copy to clipboard',2000);
}
</script>
</body>
</html>`))

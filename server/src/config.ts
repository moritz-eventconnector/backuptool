import path from "path";

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: optional("NODE_ENV", "development"),
  port: parseInt(optional("PORT", "3000"), 10),

  // Data directory
  dataDir: optional("DATA_DIR", path.join(process.cwd(), "data")),
  get dbPath() {
    return path.join(this.dataDir, "db", "backuptool.db");
  },
  get keysDir() {
    return path.join(this.dataDir, "keys");
  },

  // Master encryption secret for AES-256-GCM (encrypt credentials at rest)
  // In production, set this to a strong random 32+ char string
  masterSecret: optional("MASTER_SECRET", "change-me-in-production-32chars!!"),

  // JWT RS256 key paths (auto-generated on first start if missing)
  get jwtPrivateKeyPath() {
    return path.join(this.keysDir, "jwt_private.pem");
  },
  get jwtPublicKeyPath() {
    return path.join(this.keysDir, "jwt_public.pem");
  },

  // mTLS CA for signing agent certificates
  get caKeyPath() {
    return path.join(this.keysDir, "ca_private.pem");
  },
  get caCertPath() {
    return path.join(this.keysDir, "ca_cert.pem");
  },

  // License public key (Ed25519) — embed your public key here
  // Override via LICENSE_PUBLIC_KEY env var (base64-encoded raw 32-byte key)
  licensePublicKey: optional("LICENSE_PUBLIC_KEY", ""),

  // CORS
  corsOrigin: optional("CORS_ORIGIN", "http://localhost:5173"),

  // Cookie
  cookieSecret: optional("COOKIE_SECRET", "change-me-cookie-secret"),

  // Email (Nodemailer)
  smtp: {
    host: optional("SMTP_HOST", ""),
    port: parseInt(optional("SMTP_PORT", "587"), 10),
    secure: optional("SMTP_SECURE", "false") === "true",
    user: optional("SMTP_USER", ""),
    pass: optional("SMTP_PASS", ""),
    from: optional("SMTP_FROM", "backuptool@example.com"),
  },

  // OIDC providers (comma-separated JSON configs)
  oidc: {
    enabled: optional("OIDC_ENABLED", "false") === "true",
    issuerUrl: optional("OIDC_ISSUER_URL", ""),
    clientId: optional("OIDC_CLIENT_ID", ""),
    clientSecret: optional("OIDC_CLIENT_SECRET", ""),
    redirectUri: optional("OIDC_REDIRECT_URI", "http://localhost:3000/api/auth/oidc/callback"),
    name: optional("OIDC_PROVIDER_NAME", "SSO"),
  },

  // SAML
  saml: {
    enabled: optional("SAML_ENABLED", "false") === "true",
    entryPoint: optional("SAML_ENTRY_POINT", ""),
    issuer: optional("SAML_ISSUER", "backuptool"),
    cert: optional("SAML_CERT", ""),
    callbackUrl: optional("SAML_CALLBACK_URL", "http://localhost:3000/api/auth/saml/callback"),
  },

  // LDAP
  ldap: {
    enabled: optional("LDAP_ENABLED", "false") === "true",
    url: optional("LDAP_URL", "ldap://localhost:389"),
    bindDn: optional("LDAP_BIND_DN", ""),
    bindCredentials: optional("LDAP_BIND_CREDENTIALS", ""),
    searchBase: optional("LDAP_SEARCH_BASE", "dc=example,dc=com"),
    searchFilter: optional("LDAP_SEARCH_FILTER", "(mail={{username}})"),
    usernameField: optional("LDAP_USERNAME_FIELD", "mail"),
  },

  // Restic binary path (agents use their own path; server may need for repo init check)
  resticBin: optional("RESTIC_BIN", "restic"),
  rcloneBin: optional("RCLONE_BIN", "rclone"),
};

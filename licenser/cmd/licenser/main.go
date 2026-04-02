// Command licenser is a vendor-only CLI tool for generating, verifying, and
// managing Ed25519-signed license files (JWT format) for the backuptool product.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/backuptool/licenser/internal/license"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/cobra"
)

func main() {
	if err := rootCmd().Execute(); err != nil {
		// cobra already prints the error; just exit non-zero.
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

func rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "licenser",
		Short: "backuptool license management tool",
		Long: `licenser is a vendor-only CLI tool for generating and verifying
Ed25519-signed license files in JWT format for the backuptool product.`,
		SilenceUsage: true,
	}
	root.AddCommand(keygenCmd())
	root.AddCommand(generateCmd())
	root.AddCommand(verifyCmd())
	root.AddCommand(serveCmd())
	return root
}

// ---------------------------------------------------------------------------
// keygen subcommand
// ---------------------------------------------------------------------------

func keygenCmd() *cobra.Command {
	var privateKeyPath string
	var publicKeyPath string

	cmd := &cobra.Command{
		Use:   "keygen",
		Short: "Generate a new Ed25519 keypair",
		Long: `Generate a new Ed25519 keypair and write the private and public keys
to PEM files (PKCS8 for private, PKIX for public).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			pub, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return fmt.Errorf("generate Ed25519 keypair: %w", err)
			}

			// Marshal private key (PKCS8).
			privDER, err := x509.MarshalPKCS8PrivateKey(priv)
			if err != nil {
				return fmt.Errorf("marshal private key: %w", err)
			}
			privBlock := &pem.Block{Type: "PRIVATE KEY", Bytes: privDER}

			// Marshal public key (PKIX).
			pubDER, err := x509.MarshalPKIXPublicKey(pub)
			if err != nil {
				return fmt.Errorf("marshal public key: %w", err)
			}
			pubBlock := &pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}

			if err := writePEMFile(privateKeyPath, privBlock, 0600); err != nil {
				return fmt.Errorf("write private key: %w", err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Private key written to: %s\n", privateKeyPath)

			if err := writePEMFile(publicKeyPath, pubBlock, 0644); err != nil {
				return fmt.Errorf("write public key: %w", err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Public key written to:  %s\n", publicKeyPath)

			return nil
		},
	}

	cmd.Flags().StringVar(&privateKeyPath, "private-key", "./private.pem", "Output path for the Ed25519 private key (PKCS8 PEM)")
	cmd.Flags().StringVar(&publicKeyPath, "public-key", "./public.pem", "Output path for the Ed25519 public key (PKIX PEM)")

	return cmd
}

// ---------------------------------------------------------------------------
// generate subcommand
// ---------------------------------------------------------------------------

func generateCmd() *cobra.Command {
	var (
		privateKeyPath string
		customerID     string
		customerName   string
		edition        string
		seats          int
		featuresRaw    string
		expiryStr      string
		fingerprint    string
		outputPath     string
	)

	cmd := &cobra.Command{
		Use:   "generate",
		Short: "Generate a signed license JWT",
		Long: `Generate an Ed25519-signed license file in JWT format.
The license is written to stdout or to the file specified by --output.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate edition.
			switch edition {
			case "community", "pro", "enterprise":
			default:
				return fmt.Errorf("--edition must be one of: community, pro, enterprise (got %q)", edition)
			}

			// Parse features.
			var features []string
			if featuresRaw != "" {
				for _, f := range strings.Split(featuresRaw, ",") {
					f = strings.TrimSpace(f)
					if f != "" {
						features = append(features, f)
					}
				}
			}

			// Parse expiry.
			var expiry *jwt.NumericDate
			if expiryStr != "" {
				t, err := time.Parse("2006-01-02", expiryStr)
				if err != nil {
					return fmt.Errorf("--expiry must be in YYYY-MM-DD format: %w", err)
				}
				// Expire at end-of-day UTC on the given date.
				t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, time.UTC)
				expiry = jwt.NewNumericDate(t)
			}

			// Load private key.
			privPEM, err := os.ReadFile(privateKeyPath)
			if err != nil {
				return fmt.Errorf("read private key %q: %w", privateKeyPath, err)
			}

			claims := license.Claims{
				RegisteredClaims: jwt.RegisteredClaims{
					Subject:   customerID,
					Issuer:    "backuptool",
					IssuedAt:  jwt.NewNumericDate(time.Now().UTC()),
					ExpiresAt: expiry,
				},
				Edition:      license.Edition(edition),
				Seats:        seats,
				Features:     features,
				CustomerName: customerName,
				Fingerprint:  fingerprint,
			}

			token, err := license.Generate(privPEM, claims)
			if err != nil {
				return fmt.Errorf("generate license: %w", err)
			}

			if outputPath == "" || outputPath == "-" {
				fmt.Fprintln(cmd.OutOrStdout(), token)
				return nil
			}

			if err := os.WriteFile(outputPath, []byte(token+"\n"), 0644); err != nil {
				return fmt.Errorf("write license file %q: %w", outputPath, err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "License written to: %s\n", outputPath)
			return nil
		},
	}

	cmd.Flags().StringVar(&privateKeyPath, "private-key", "", "Path to Ed25519 private key PEM file (required)")
	cmd.Flags().StringVar(&customerID, "customer-id", "", "Customer identifier (used as JWT subject)")
	cmd.Flags().StringVar(&customerName, "customer-name", "", "Customer display name")
	cmd.Flags().StringVar(&edition, "edition", "pro", `Product edition: "community", "pro", or "enterprise"`)
	cmd.Flags().IntVar(&seats, "seats", 5, "Number of agent seats")
	cmd.Flags().StringVar(&featuresRaw, "features", "", `Comma-separated feature list (e.g. "sso,audit_log,k8s_agent")`)
	cmd.Flags().StringVar(&expiryStr, "expiry", "", "Expiry date in YYYY-MM-DD format (omit for perpetual license)")
	cmd.Flags().StringVar(&fingerprint, "fingerprint", "", "Optional machine fingerprint hash")
	cmd.Flags().StringVar(&outputPath, "output", "", "Output file path (default: stdout)")

	_ = cmd.MarkFlagRequired("private-key")

	return cmd
}

// ---------------------------------------------------------------------------
// verify subcommand
// ---------------------------------------------------------------------------

func verifyCmd() *cobra.Command {
	var (
		licensePath   string
		publicKeyPath string
	)

	cmd := &cobra.Command{
		Use:   "verify",
		Short: "Verify a license JWT and display its claims",
		Long:  `Verify the Ed25519 signature of a license JWT and print its claims in a human-readable format.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			tokenBytes, err := os.ReadFile(licensePath)
			if err != nil {
				return fmt.Errorf("read license file %q: %w", licensePath, err)
			}
			tokenStr := strings.TrimSpace(string(tokenBytes))

			pubPEM, err := os.ReadFile(publicKeyPath)
			if err != nil {
				return fmt.Errorf("read public key %q: %w", publicKeyPath, err)
			}

			claims, err := license.Verify(tokenStr, pubPEM)
			if err != nil {
				return fmt.Errorf("license verification failed: %w", err)
			}

			out := cmd.OutOrStdout()
			fmt.Fprintln(out, "License is VALID")
			fmt.Fprintln(out)

			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintf(w, "Customer ID\t%s\n", claims.Subject)
			fmt.Fprintf(w, "Customer Name\t%s\n", claims.CustomerName)
			fmt.Fprintf(w, "Edition\t%s\n", claims.Edition)
			fmt.Fprintf(w, "Seats\t%d\n", claims.Seats)
			fmt.Fprintf(w, "Features\t%s\n", formatFeatures(claims.Features))
			fmt.Fprintf(w, "Issuer\t%s\n", claims.Issuer)
			if claims.IssuedAt != nil {
				fmt.Fprintf(w, "Issued At\t%s\n", claims.IssuedAt.Time.UTC().Format(time.RFC3339))
			}
			if claims.ExpiresAt != nil {
				remaining := time.Until(claims.ExpiresAt.Time).Round(time.Hour * 24)
				fmt.Fprintf(w, "Expires At\t%s  (%s remaining)\n",
					claims.ExpiresAt.Time.UTC().Format("2006-01-02"),
					formatDuration(remaining),
				)
			} else {
				fmt.Fprintf(w, "Expires At\t(perpetual — no expiry)\n")
			}
			if claims.Fingerprint != "" {
				fmt.Fprintf(w, "Fingerprint\t%s\n", claims.Fingerprint)
			}
			_ = w.Flush()

			return nil
		},
	}

	cmd.Flags().StringVar(&licensePath, "license", "", "Path to license JWT file (required)")
	cmd.Flags().StringVar(&publicKeyPath, "public-key", "", "Path to Ed25519 public key PEM file (required)")

	_ = cmd.MarkFlagRequired("license")
	_ = cmd.MarkFlagRequired("public-key")

	return cmd
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writePEMFile(path string, block *pem.Block, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	return pem.Encode(f, block)
}

func formatFeatures(features []string) string {
	if len(features) == 0 {
		return "(none)"
	}
	return strings.Join(features, ", ")
}

func formatDuration(d time.Duration) string {
	if d < 0 {
		return "EXPIRED"
	}
	days := int(d.Hours() / 24)
	switch {
	case days >= 365:
		return fmt.Sprintf("~%d years", days/365)
	case days >= 30:
		return fmt.Sprintf("~%d months", days/30)
	default:
		return fmt.Sprintf("%d days", days)
	}
}

// Package license provides Ed25519-signed JWT license generation and verification
// for the backuptool licensing system.
package license

import (
	"crypto"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Edition represents a product tier.
type Edition string

const (
	EditionCommunity  Edition = "community"
	EditionPro        Edition = "pro"
	EditionEnterprise Edition = "enterprise"
)

// Claims holds all license JWT claims, both standard and custom.
type Claims struct {
	// Standard JWT fields
	jwt.RegisteredClaims

	// License-specific fields
	Edition      Edition  `json:"edition"`
	Seats        int      `json:"seats"`
	Features     []string `json:"features"`
	CustomerName string   `json:"customerName"`
	Fingerprint  string   `json:"fingerprint,omitempty"`
}

// Generate creates a signed Ed25519 JWT from the provided claims.
// privateKeyPEM must be a PKCS8-encoded Ed25519 private key in PEM format.
func Generate(privateKeyPEM []byte, claims Claims) (string, error) {
	key, err := parsePrivateKeyPEM(privateKeyPEM)
	if err != nil {
		return "", fmt.Errorf("parse private key: %w", err)
	}

	ed, ok := key.(ed25519.PrivateKey)
	if !ok {
		return "", errors.New("private key is not an Ed25519 key")
	}

	// Ensure issuer and issued-at are always set.
	if claims.Issuer == "" {
		claims.Issuer = "backuptool"
	}
	if claims.IssuedAt == nil {
		claims.IssuedAt = jwt.NewNumericDate(time.Now().UTC())
	}

	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signed, err := token.SignedString(ed)
	if err != nil {
		return "", fmt.Errorf("sign token: %w", err)
	}

	return signed, nil
}

// Verify parses and validates a license JWT string using the given Ed25519 public key PEM.
// It returns the parsed Claims on success.
func Verify(tokenStr string, publicKeyPEM []byte) (*Claims, error) {
	pub, err := parsePublicKeyPEM(publicKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}

	edPub, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("public key is not an Ed25519 key")
	}

	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodEd25519); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return edPub, nil
	}, jwt.WithIssuedAt())
	if err != nil {
		return nil, fmt.Errorf("verify token: %w", err)
	}
	if !token.Valid {
		return nil, errors.New("token is invalid")
	}

	return claims, nil
}

// LoadPrivateKey reads a PKCS8 PEM file from disk and returns the private key.
func LoadPrivateKey(pemPath string) (crypto.PrivateKey, error) {
	data, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("read private key file %q: %w", pemPath, err)
	}
	return parsePrivateKeyPEM(data)
}

// LoadPublicKey reads a PKIX PEM file from disk and returns the public key.
func LoadPublicKey(pemPath string) (crypto.PublicKey, error) {
	data, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("read public key file %q: %w", pemPath, err)
	}
	return parsePublicKeyPEM(data)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func parsePrivateKeyPEM(pemData []byte) (crypto.PrivateKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, errors.New("no PEM block found in private key data")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKCS8 private key: %w", err)
	}
	return key, nil
}

func parsePublicKeyPEM(pemData []byte) (crypto.PublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, errors.New("no PEM block found in public key data")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX public key: %w", err)
	}
	return key, nil
}

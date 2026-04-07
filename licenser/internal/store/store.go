// Package store provides a thread-safe JSON file store for license records.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// LicenseRecord is the persisted representation of a generated license.
type LicenseRecord struct {
	ID           string   `json:"id"`
	CustomerID   string   `json:"customerId"`
	CustomerName string   `json:"customerName"`
	Edition      string   `json:"edition"`
	Seats        int      `json:"seats"`
	Features     []string `json:"features"`
	Fingerprint  string   `json:"fingerprint,omitempty"`
	RawJWT       string   `json:"rawJwt"`
	ExpiresAt    string   `json:"expiresAt,omitempty"`
	Notes        string   `json:"notes,omitempty"`
	Revoked      bool     `json:"revoked"`
	RevokedAt    string   `json:"revokedAt,omitempty"`
	CreatedAt    string   `json:"createdAt"`
}

// Stats holds aggregate counts over all license records.
type Stats struct {
	Total        int `json:"total"`
	Active       int `json:"active"`
	ExpiringSoon int `json:"expiringSoon"`
	Revoked      int `json:"revoked"`
}

// Store is a thread-safe JSON file-backed store for license records.
type Store struct {
	mu       sync.RWMutex
	dataDir  string
	filePath string
	records  []LicenseRecord
}

// New creates (or opens) the store at dataDir/licenses.json.
func New(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir %q: %w", dataDir, err)
	}

	s := &Store{
		dataDir:  dataDir,
		filePath: filepath.Join(dataDir, "licenses.json"),
	}

	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Add appends a record and atomically saves to disk.
func (s *Store) Add(r LicenseRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records = append(s.records, r)
	return s.saveLocked()
}

// List returns a copy of all records sorted newest first (by CreatedAt).
func (s *Store) List() []LicenseRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]LicenseRecord, len(s.records))
	copy(out, s.records)

	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

// Get returns the record with the given ID, or false if not found.
func (s *Store) Get(id string) (LicenseRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.records {
		if r.ID == id {
			return r, true
		}
	}
	return LicenseRecord{}, false
}

// Revoke marks the record with the given ID as revoked.
func (s *Store) Revoke(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, r := range s.records {
		if r.ID == id {
			if s.records[i].Revoked {
				return fmt.Errorf("license %q is already revoked", id)
			}
			s.records[i].Revoked = true
			s.records[i].RevokedAt = time.Now().UTC().Format(time.RFC3339)
			return s.saveLocked()
		}
	}
	return fmt.Errorf("license %q not found", id)
}

// Stats returns aggregate counts over all stored records.
func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().UTC()
	soon := now.Add(30 * 24 * time.Hour)

	var st Stats
	for _, r := range s.records {
		st.Total++
		if r.Revoked {
			st.Revoked++
			continue
		}
		if r.ExpiresAt == "" {
			// Perpetual license — always active.
			st.Active++
			continue
		}
		t, err := time.Parse(time.RFC3339, r.ExpiresAt)
		if err != nil {
			st.Active++
			continue
		}
		if t.Before(now) {
			// Expired — not counted as active.
			continue
		}
		st.Active++
		if t.Before(soon) {
			st.ExpiringSoon++
		}
	}
	return st
}

// GenerateID returns a random 16-hex-character ID (8 bytes).
func GenerateID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type storeFile struct {
	Records []LicenseRecord `json:"records"`
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		s.records = []LicenseRecord{}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read store file %q: %w", s.filePath, err)
	}

	var sf storeFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return fmt.Errorf("parse store file %q: %w", s.filePath, err)
	}
	s.records = sf.Records
	if s.records == nil {
		s.records = []LicenseRecord{}
	}
	return nil
}

// saveLocked writes the store atomically. Caller must hold s.mu (write).
func (s *Store) saveLocked() error {
	sf := storeFile{Records: s.records}
	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal store: %w", err)
	}

	tmp := s.filePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("write temp file %q: %w", tmp, err)
	}
	if err := os.Rename(tmp, s.filePath); err != nil {
		return fmt.Errorf("atomic rename store: %w", err)
	}
	return nil
}

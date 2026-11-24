package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	maxFileSize = int64(10 << 30)
	chunkSize   = int64(4 << 20)
	claimIdle   = 2 * time.Minute
)

var validID = regexp.MustCompile(`^[a-f0-9]{48}$`)
var errGone = errors.New("space expired or deleted")

type fileMeta struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Uploaded int64  `json:"uploaded"`
}

type claim struct {
	LastSeen time.Time `json:"lastSeen"`
	Finished bool      `json:"finished"`
}

type metadata struct {
	ID           string            `json:"id"`
	OwnerHash    string            `json:"ownerHash"`
	Created      time.Time         `json:"created"`
	Expires      time.Time         `json:"expires"`
	MaxDownloads int               `json:"maxDownloads"`
	Downloads    int               `json:"downloads"`
	Files        []fileMeta        `json:"files"`
	Claims       map[string]*claim `json:"claims"`
}

type space struct {
	mu      sync.Mutex
	meta    metadata
	dir     string
	changed chan struct{}
	done    chan struct{}
	deleted bool
	active  int
	peers   map[string]*peer
	uploads []sync.Mutex
}

type fileStore struct {
	mu     sync.RWMutex
	root   string
	spaces map[string]*space
}

func randomID() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func openStore(root string) (*fileStore, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	s := &fileStore{root: root, spaces: make(map[string]*space)}
	for _, entry := range entries {
		if !entry.IsDir() || !validID.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		body, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			return nil, fmt.Errorf("read %s metadata: %w", entry.Name(), err)
		}
		var m metadata
		if err := json.Unmarshal(body, &m); err != nil {
			return nil, fmt.Errorf("parse %s metadata: %w", entry.Name(), err)
		}
		if m.ID != entry.Name() || m.Claims == nil || len(m.Files) == 0 || m.MaxDownloads < 1 || m.MaxDownloads > 100 || m.Downloads < 0 || m.Downloads > m.MaxDownloads || m.OwnerHash == "" || m.Expires.IsZero() {
			return nil, fmt.Errorf("invalid metadata in %s", dir)
		}
		for i, f := range m.Files {
			if f.Size < 0 || f.Size > maxFileSize || f.Uploaded < 0 || f.Uploaded > f.Size {
				return nil, fmt.Errorf("invalid file metadata in %s", dir)
			}
			path := filepath.Join(dir, strconv.Itoa(i)+".data")
			info, err := os.Lstat(path)
			if err != nil || !info.Mode().IsRegular() || info.Size() < f.Uploaded {
				return nil, fmt.Errorf("missing or truncated committed file %s", path)
			}
			if info.Size() != f.Uploaded {
				if err := os.Truncate(path, f.Uploaded); err != nil {
					return nil, err
				}
			}
		}
		staged, err := filepath.Glob(filepath.Join(dir, "chunk-*.part"))
		if err != nil {
			return nil, err
		}
		for _, path := range staged {
			if err := os.Remove(path); err != nil {
				return nil, fmt.Errorf("remove uncommitted chunk: %w", err)
			}
		}
		s.spaces[m.ID] = newSpace(m, dir)
	}
	s.clean(time.Now())
	return s, nil
}

func newSpace(m metadata, dir string) *space {
	return &space{meta: m, dir: dir, changed: make(chan struct{}), done: make(chan struct{}), peers: make(map[string]*peer), uploads: make([]sync.Mutex, len(m.Files))}
}

func (s *space) save() error {
	body, err := json.Marshal(s.meta)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, "meta.next")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(body)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return os.Rename(path, filepath.Join(s.dir, "meta.json"))
}

func (s *space) notify() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *space) live() bool {
	return !s.deleted && time.Now().Before(s.meta.Expires)
}

func (s *space) owner(token string) bool {
	return validID.MatchString(token) && hashToken(token) == s.meta.OwnerHash
}

func (s *space) authorizedClaim(token string) *claim {
	if !validID.MatchString(token) {
		return nil
	}
	c := s.meta.Claims[hashToken(token)]
	if c == nil || c.Finished || time.Since(c.LastSeen) > claimIdle {
		return nil
	}
	return c
}

func (s *fileStore) get(id string) *space {
	if !validID.MatchString(id) {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.spaces[id]
}

func (s *fileStore) create(files []fileMeta, hours, downloads int) (*space, string, error) {
	id, err := randomID()
	if err != nil {
		return nil, "", err
	}
	owner, err := randomID()
	if err != nil {
		return nil, "", err
	}
	dir := filepath.Join(s.root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return nil, "", err
	}
	ok := false
	defer func() {
		if !ok {
			if err := os.RemoveAll(dir); err != nil {
				slog.Error("clean failed creation", "space", id, "error", err)
			}
		}
	}()
	now := time.Now().UTC()
	sp := newSpace(metadata{ID: id, OwnerHash: hashToken(owner), Created: now, Expires: now.Add(time.Duration(hours) * time.Hour), MaxDownloads: downloads, Files: files, Claims: make(map[string]*claim)}, dir)
	for i := range files {
		f, err := os.OpenFile(filepath.Join(dir, strconv.Itoa(i)+".data"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, "", err
		}
		if err := f.Close(); err != nil {
			return nil, "", err
		}
	}
	if err := sp.save(); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	s.spaces[id] = sp
	s.mu.Unlock()
	ok = true
	return sp, owner, nil
}

func (s *space) appendChunk(index int, offset int64, body io.Reader, length int64) error {
	fm := &s.meta.Files[index]
	if offset != fm.Uploaded {
		return fmt.Errorf("offset mismatch: server has %d bytes", fm.Uploaded)
	}
	if length <= 0 || length > chunkSize || length > fm.Size-offset {
		return errors.New("invalid chunk length")
	}
	f, err := os.OpenFile(filepath.Join(s.dir, strconv.Itoa(index)+".data"), os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Seek(offset, io.SeekStart); err == nil {
		_, err = io.CopyN(f, body, length)
	}
	if err == nil {
		err = f.Sync()
	}
	if err == nil {
		fm.Uploaded += length
		err = s.save()
		if err != nil {
			fm.Uploaded = offset
		}
	}
	if err != nil {
		err = errors.Join(err, f.Truncate(offset))
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	s.notify()
	return nil
}

func (s *fileStore) cleanLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			s.clean(now)
		case <-ctx.Done():
			return
		}
	}
}

func (s *fileStore) clean(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sp := range s.spaces {
		sp.mu.Lock()
		exhausted := sp.meta.Downloads >= sp.meta.MaxDownloads && sp.active == 0
		if exhausted {
			for _, c := range sp.meta.Claims {
				if !c.Finished && now.Sub(c.LastSeen) <= claimIdle {
					exhausted = false
					break
				}
			}
		}
		if !now.Before(sp.meta.Expires) || exhausted || sp.deleted {
			if !sp.deleted {
				sp.deleted = true
				close(sp.done)
				sp.notify()
			}
			if err := os.RemoveAll(sp.dir); err != nil {
				slog.Error("remove expired space", "space", id, "error", err)
			} else {
				delete(s.spaces, id)
				slog.Info("space removed", "space", id)
			}
		}
		sp.mu.Unlock()
	}
}

func (s *fileStore) shutdown() {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sp := range s.spaces {
		sp.mu.Lock()
		sp.deleted = true
		close(sp.done)
		sp.notify()
		sp.mu.Unlock()
	}
}

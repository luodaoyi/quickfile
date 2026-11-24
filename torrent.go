package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

// Each file is an isolated private torrent. No public trackers or DHT are advertised.
func torrentDescriptor(id string, index int, file fileMeta, hashes []string) ([]byte, error) {
	if len(hashes) != int((file.Size+chunkSize-1)/chunkSize) {
		return nil, errors.New("piece hash count does not match file size")
	}
	var pieces bytes.Buffer
	for _, hash := range hashes {
		raw, err := hex.DecodeString(hash)
		if err != nil || len(raw) != sha1.Size {
			return nil, errors.New("piece hashes must be SHA-1 hex strings")
		}
		pieces.Write(raw)
	}
	var out bytes.Buffer
	str := func(b []byte) { fmt.Fprintf(&out, "%d:", len(b)); out.Write(b) }
	text := func(s string) { str([]byte(s)) }
	number := func(n int64) { fmt.Fprintf(&out, "i%de", n) }
	// BEP 3 dictionary keys are sorted bytewise.
	out.WriteString("d4:infod6:length")
	number(file.Size)
	text("name")
	text(file.Name)
	text("piece length")
	number(chunkSize)
	text("pieces")
	str(pieces.Bytes())
	text("private")
	number(1)
	text("source")
	text(id + "/" + strconv.Itoa(index))
	out.WriteString("ee")
	return out.Bytes(), nil
}

func (a *application) torrent(w http.ResponseWriter, r *http.Request) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	index, ok := fileIndex(r, sp)
	credential := bearer(r)
	if credential == "" {
		credential = r.URL.Query().Get("claim")
	}
	owner := sp.owner(credential)
	if !sp.live() || (!owner && sp.authorizedClaim(credential) == nil) {
		sp.mu.Unlock()
		writeError(w, 403, "invalid torrent credential")
		return
	}
	if !ok {
		sp.mu.Unlock()
		writeError(w, 404, "file not found")
		return
	}
	if r.Method == "POST" && !owner {
		sp.mu.Unlock()
		writeError(w, 403, "upload credential required")
		return
	}
	file := sp.meta.Files[index]
	sp.active++
	sp.mu.Unlock()
	defer sp.endRead()
	sp.uploads[index].Lock()
	defer sp.uploads[index].Unlock()
	path := filepath.Join(sp.dir, strconv.Itoa(index)+".torrent")
	existing, readErr := os.ReadFile(path)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		writeError(w, 500, readErr.Error())
		return
	}
	if r.Method == "GET" && readErr == nil {
		w.Header().Set("Content-Type", "application/x-bittorrent")
		w.Write(existing)
		return
	}
	var hashes []string
	if r.Method == "POST" {
		var req struct {
			Hashes []string `json:"hashes"`
		}
		if !decode(w, r, &req) {
			return
		}
		hashes = req.Hashes
	} else {
		if file.Uploaded != file.Size {
			writeError(w, 409, "torrent manifest not ready; sender is still preparing or uploading the file")
			return
		}
		f, err := os.Open(filepath.Join(sp.dir, strconv.Itoa(index)+".data"))
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		defer f.Close()
		for offset := int64(0); offset < file.Size; offset += chunkSize {
			if err := r.Context().Err(); err != nil {
				return
			}
			hash := sha1.New()
			if _, err := io.CopyN(hash, f, min(chunkSize, file.Size-offset)); err != nil {
				writeError(w, 500, err.Error())
				return
			}
			hashes = append(hashes, hex.EncodeToString(hash.Sum(nil)))
		}
	}
	descriptor, err := torrentDescriptor(sp.meta.ID, index, file, hashes)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if readErr == nil {
		if !bytes.Equal(existing, descriptor) {
			writeError(w, 409, "torrent manifest is immutable")
			return
		}
	} else {
		f, err := os.CreateTemp(sp.dir, "chunk-torrent-*.part")
		if err != nil {
			writeError(w, 507, err.Error())
			return
		}
		defer os.Remove(f.Name())
		_, writeErr := f.Write(descriptor)
		syncErr := f.Sync()
		closeErr := f.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			writeError(w, 507, err.Error())
			return
		}
		if err := os.Rename(f.Name(), path); err != nil {
			writeError(w, 507, err.Error())
			return
		}
	}
	if r.Method == "POST" {
		w.WriteHeader(204)
		return
	}
	w.Header().Set("Content-Type", "application/x-bittorrent")
	w.Write(descriptor)
}

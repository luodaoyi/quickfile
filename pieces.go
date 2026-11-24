package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type byteRange struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

func (f fileMeta) committedEnd() (int64, error) {
	end := f.Uploaded
	for _, part := range f.Ranges {
		if part.Start <= end || part.End <= part.Start || part.End > f.Size {
			return 0, errors.New("overlapping or invalid committed ranges")
		}
		end = part.End
	}
	return end, nil
}

func (f fileMeta) availableEnd(start int64) int64 {
	if start < f.Uploaded {
		return f.Uploaded
	}
	for _, part := range f.Ranges {
		if part.Start <= start && start < part.End {
			return part.End
		}
	}
	return start
}

func (f fileMeta) received() int64 {
	n := f.Uploaded
	for _, part := range f.Ranges {
		n += part.End - part.Start
	}
	return n
}

func (f *fileMeta) commitRange(part byteRange) {
	parts := append(slices.Clone(f.Ranges), part)
	slices.SortFunc(parts, func(a, b byteRange) int {
		if a.Start < b.Start {
			return -1
		}
		if a.Start > b.Start {
			return 1
		}
		return 0
	})
	f.Ranges = nil
	for _, r := range parts {
		if r.Start <= f.Uploaded {
			f.Uploaded = max(f.Uploaded, r.End)
			continue
		}
		if len(f.Ranges) > 0 && r.Start <= f.Ranges[len(f.Ranges)-1].End {
			f.Ranges[len(f.Ranges)-1].End = max(f.Ranges[len(f.Ranges)-1].End, r.End)
		} else {
			f.Ranges = append(f.Ranges, r)
		}
	}
}

func rangeOverlap(a, b byteRange) bool { return a.Start < b.End && b.Start < a.End }

func (sp *space) fileInflight(index int) bool {
	prefix := strconv.Itoa(index) + ":"
	for key := range sp.inflight {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func (a *application) uploadParallel(w http.ResponseWriter, r *http.Request) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	i, ok := fileIndex(r, sp)
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if !ok || err != nil || offset < 0 || r.ContentLength <= 0 || r.ContentLength > chunkSize || offset > sp.meta.Files[i].Size-r.ContentLength {
		sp.mu.Unlock()
		writeError(w, 400, "invalid file, chunk size, or offset")
		return
	}
	if !sp.live() {
		sp.mu.Unlock()
		writeError(w, 410, errGone.Error())
		return
	}
	if !sp.owner(bearer(r)) {
		sp.mu.Unlock()
		writeError(w, 403, "invalid upload credential")
		return
	}
	part := byteRange{offset, offset + r.ContentLength}
	fm := sp.meta.Files[i]
	conflict := part.Start < fm.Uploaded
	for _, p := range fm.Ranges {
		conflict = conflict || rangeOverlap(p, part)
	}
	for key, p := range sp.inflight {
		if strings.HasPrefix(key, strconv.Itoa(i)+":") {
			conflict = conflict || rangeOverlap(p, part)
		}
	}
	if conflict || !sp.uploads[i].TryLock() {
		sp.mu.Unlock()
		writeJSON(w, 409, map[string]any{"error": "range overlaps committed or in-flight data", "uploaded": fm.Uploaded, "ranges": fm.Ranges})
		return
	}
	key := fmt.Sprintf("%d:%d", i, offset)
	sp.inflight[key] = part
	sp.active++
	expires := sp.meta.Expires
	sp.uploads[i].Unlock()
	sp.mu.Unlock()
	defer func() { sp.mu.Lock(); delete(sp.inflight, key); sp.active--; sp.mu.Unlock() }()
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(expires); err != nil {
		writeError(w, 500, "cannot set upload expiry: "+err.Error())
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	f, err := os.OpenFile(filepath.Join(sp.dir, strconv.Itoa(i)+".data"), os.O_WRONLY, 0600)
	if err != nil {
		writeError(w, 507, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, chunkSize)
	_, writeErr := io.CopyN(io.NewOffsetWriter(f, offset), r.Body, r.ContentLength)
	var syncErr error
	if writeErr == nil {
		syncErr = f.Sync()
	}
	if err := errors.Join(writeErr, syncErr, f.Close()); err != nil {
		writeError(w, 400, "upload range not committed: "+err.Error())
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.live() {
		writeError(w, 410, errGone.Error())
		return
	}
	old := sp.meta.Files[i]
	sp.meta.Files[i].commitRange(part)
	if err := sp.save(); err != nil {
		sp.meta.Files[i] = old
		writeError(w, 507, "cannot commit upload metadata: "+err.Error())
		return
	}
	sp.notify()
	fm = sp.meta.Files[i]
	writeJSON(w, 200, map[string]any{"uploaded": fm.Uploaded, "received": fm.received(), "ranges": fm.Ranges})
}

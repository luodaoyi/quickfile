package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type application struct {
	store  *fileStore
	assets http.Handler
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "version": version})
	})
	mux.HandleFunc("POST /api/spaces", a.createSpace)
	mux.HandleFunc("GET /api/spaces/{id}", a.getSpace)
	mux.HandleFunc("PATCH /api/spaces/{id}/files/{file}", a.upload)
	mux.HandleFunc("POST /api/spaces/{id}/claims", a.claimSpace)
	mux.HandleFunc("POST /api/spaces/{id}/heartbeat", a.heartbeat)
	mux.HandleFunc("POST /api/spaces/{id}/complete", a.complete)
	mux.HandleFunc("GET /api/spaces/{id}/files/{file}", a.download)
	mux.HandleFunc("GET /api/spaces/{id}/archive", a.archive)
	mux.HandleFunc("GET /api/spaces/{id}/ws", a.socket)
	mux.HandleFunc("GET /s/{id}", func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/"
		a.assets.ServeHTTP(w, r)
	})
	mux.Handle("GET /", a.assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+r.Host && origin != "http://"+r.Host {
			writeError(w, 403, "cross-origin request denied")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Warn("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		writeError(w, 400, "invalid request: "+err.Error())
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		writeError(w, 400, "expected one JSON object")
		return false
	}
	return true
}

func view(sp *space) any {
	return struct {
		ID           string     `json:"id"`
		Created      time.Time  `json:"created"`
		Expires      time.Time  `json:"expires"`
		MaxDownloads int        `json:"maxDownloads"`
		Downloads    int        `json:"downloads"`
		Files        []fileMeta `json:"files"`
		SenderOnline bool       `json:"senderOnline"`
	}{sp.meta.ID, sp.meta.Created, sp.meta.Expires, sp.meta.MaxDownloads, sp.meta.Downloads, sp.meta.Files, sp.peers["sender"] != nil}
}

func (a *application) find(w http.ResponseWriter, r *http.Request) *space {
	sp := a.store.get(r.PathValue("id"))
	if sp == nil {
		writeError(w, 410, errGone.Error())
		return nil
	}
	return sp
}

func bearer(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func (a *application) createSpace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Files []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
		} `json:"files"`
		Hours        int `json:"hours"`
		MaxDownloads int `json:"maxDownloads"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Hours == 0 {
		req.Hours = 24
	}
	if req.MaxDownloads == 0 {
		req.MaxDownloads = 100
	}
	if !oneOf(req.Hours, 1, 2, 6, 12, 24) || !oneOf(req.MaxDownloads, 1, 5, 10, 20, 50, 100) || len(req.Files) == 0 {
		writeError(w, 400, "invalid expiry, download limit, or file list")
		return
	}
	files := make([]fileMeta, len(req.Files))
	for i, f := range req.Files {
		if f.Name == "" || len(f.Name) > 255 || f.Name == "." || f.Name == ".." || strings.ContainsAny(f.Name, `/\`) || strings.ContainsFunc(f.Name, unicode.IsControl) {
			writeError(w, 400, "invalid file name")
			return
		}
		if f.Size < 0 || f.Size > maxFileSize {
			writeError(w, 413, "each file must be at most 10 GiB")
			return
		}
		files[i] = fileMeta{Name: f.Name, Size: f.Size}
	}
	sp, owner, err := a.store.create(files, req.Hours, req.MaxDownloads)
	if err != nil {
		slog.Error("create space", "error", err)
		writeError(w, 507, "cannot create space: "+err.Error())
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	writeJSON(w, 201, map[string]any{"space": view(sp), "owner": owner, "chunkSize": chunkSize})
}

func oneOf(v int, allowed ...int) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func (a *application) getSpace(w http.ResponseWriter, r *http.Request) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.live() {
		writeError(w, 410, errGone.Error())
		return
	}
	writeJSON(w, 200, view(sp))
}

func fileIndex(r *http.Request, sp *space) (int, bool) {
	i, err := strconv.Atoi(r.PathValue("file"))
	return i, err == nil && i >= 0 && i < len(sp.meta.Files)
}

func (a *application) upload(w http.ResponseWriter, r *http.Request) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
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
	i, ok := fileIndex(r, sp)
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if !ok || err != nil || r.ContentLength <= 0 || r.ContentLength > chunkSize {
		sp.mu.Unlock()
		writeError(w, 400, "invalid file, chunk size, or offset")
		return
	}
	expires := sp.meta.Expires
	sp.mu.Unlock()
	sp.uploads[i].Lock()
	defer sp.uploads[i].Unlock()
	sp.mu.Lock()
	if !sp.live() {
		sp.mu.Unlock()
		writeError(w, 410, errGone.Error())
		return
	}
	uploaded, size := sp.meta.Files[i].Uploaded, sp.meta.Files[i].Size
	sp.mu.Unlock()
	if offset != uploaded {
		writeJSON(w, 409, map[string]any{"error": "offset mismatch", "uploaded": uploaded})
		return
	}
	if r.ContentLength > size-offset {
		writeError(w, 400, "chunk exceeds declared file size")
		return
	}
	// Receive outside the metadata lock so a slow uploader cannot stall links or downloads.
	staged, err := os.CreateTemp(sp.dir, "chunk-*.part")
	if err != nil {
		writeError(w, 507, "cannot stage upload: "+err.Error())
		return
	}
	defer func() {
		if err := os.Remove(staged.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("remove staged chunk", "error", err)
		}
	}()
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(expires); err != nil {
		staged.Close()
		writeError(w, 500, "cannot set upload expiry: "+err.Error())
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	r.Body = http.MaxBytesReader(w, r.Body, chunkSize)
	_, readErr := io.CopyN(staged, r.Body, r.ContentLength)
	closeErr := staged.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		writeError(w, 400, "incomplete upload chunk: "+err.Error())
		return
	}
	src, err := os.Open(staged.Name())
	if err != nil {
		writeError(w, 507, "cannot read staged chunk: "+err.Error())
		return
	}
	defer src.Close()
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.live() {
		writeError(w, 410, errGone.Error())
		return
	}
	if err := sp.appendChunk(i, offset, src, r.ContentLength); err != nil {
		slog.Error("upload chunk", "space", sp.meta.ID, "file", i, "error", err)
		writeError(w, 507, "upload failed: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]int64{"uploaded": sp.meta.Files[i].Uploaded})
}

func (a *application) claimSpace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !validID.MatchString(req.Token) {
		writeError(w, 400, "invalid claim token")
		return
	}
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.live() {
		writeError(w, 410, errGone.Error())
		return
	}
	key := hashToken(req.Token)
	if old := sp.meta.Claims[key]; old != nil {
		if sp.authorizedClaim(req.Token) == nil {
			writeError(w, 410, "claim already completed or inactive")
			return
		}
		writeJSON(w, 200, map[string]string{"peer": key})
		return
	}
	if sp.meta.Downloads >= sp.meta.MaxDownloads {
		writeError(w, 410, "download limit reached")
		return
	}
	sp.meta.Claims[key] = &claim{LastSeen: time.Now().UTC()}
	sp.meta.Downloads++
	if err := sp.save(); err != nil {
		delete(sp.meta.Claims, key)
		sp.meta.Downloads--
		writeError(w, 507, "cannot save claim: "+err.Error())
		return
	}
	sp.notify()
	writeJSON(w, 201, map[string]string{"peer": key})
}

func (a *application) heartbeat(w http.ResponseWriter, r *http.Request) {
	a.updateClaim(w, r, false)
}

func (a *application) complete(w http.ResponseWriter, r *http.Request) {
	a.updateClaim(w, r, true)
}

func (a *application) updateClaim(w http.ResponseWriter, r *http.Request, finish bool) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	c := sp.authorizedClaim(bearer(r))
	if !sp.live() || c == nil {
		writeError(w, 410, "claim expired or completed")
		return
	}
	old := *c
	c.LastSeen, c.Finished = time.Now().UTC(), finish
	if err := sp.save(); err != nil {
		*c = old
		writeError(w, 507, "cannot save claim: "+err.Error())
		return
	}
	w.WriteHeader(204)
}

func (a *application) startRead(w http.ResponseWriter, r *http.Request) *space {
	sp := a.find(w, r)
	if sp == nil {
		return nil
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	token := bearer(r)
	if token == "" {
		token = r.URL.Query().Get("claim")
	}
	c := sp.authorizedClaim(token)
	if !sp.live() || c == nil {
		writeError(w, 410, "claim expired or completed")
		return nil
	}
	c.LastSeen = time.Now().UTC()
	sp.active++
	return sp
}

func (sp *space) endRead() {
	sp.mu.Lock()
	sp.active--
	sp.mu.Unlock()
}

// readFile waits at the committed boundary instead of returning a partial file as a successful download.
func (sp *space) readFile(r *http.Request, dst io.Writer, index int, start, end int64) error {
	f, err := os.Open(filepath.Join(sp.dir, strconv.Itoa(index)+".data"))
	if err != nil {
		return err
	}
	defer f.Close()
	for start < end {
		sp.mu.Lock()
		if !sp.live() {
			sp.mu.Unlock()
			return errGone
		}
		available := min(sp.meta.Files[index].Uploaded, end)
		changed := sp.changed
		expires := time.Until(sp.meta.Expires)
		sp.mu.Unlock()
		if available > start {
			limit := min(available, start+(256<<10))
			if _, err := io.Copy(dst, io.NewSectionReader(f, start, limit-start)); err != nil {
				return err
			}
			if flush, ok := dst.(http.Flusher); ok {
				flush.Flush()
			}
			start = limit
			continue
		}
		timer := time.NewTimer(expires)
		select {
		case <-changed:
			timer.Stop()
		case <-sp.done:
			timer.Stop()
			return errGone
		case <-r.Context().Done():
			timer.Stop()
			return r.Context().Err()
		case <-timer.C:
			return errGone
		}
	}
	return nil
}

func parseRange(header string, size int64) (int64, int64, error) {
	if header == "" {
		return 0, size, nil
	}
	if !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") || size == 0 {
		return 0, 0, errors.New("one byte range required")
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(parts) != 2 {
		return 0, 0, errors.New("invalid range")
	}
	if parts[0] == "" {
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, errors.New("invalid suffix range")
		}
		return max(0, size-n), size, nil
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, errors.New("range outside file")
	}
	end := size
	if parts[1] != "" {
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n < start {
			return 0, 0, errors.New("invalid range end")
		}
		end = min(n, size-1) + 1
	}
	return start, end, nil
}

func (a *application) download(w http.ResponseWriter, r *http.Request) {
	sp := a.startRead(w, r)
	if sp == nil {
		return
	}
	defer sp.endRead()
	sp.mu.Lock()
	i, ok := fileIndex(r, sp)
	if !ok {
		sp.mu.Unlock()
		writeError(w, 404, "file not found")
		return
	}
	f := sp.meta.Files[i]
	sp.mu.Unlock()
	start, end, err := parseRange(r.Header.Get("Range"), f.Size)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", f.Size))
		writeError(w, 416, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(end-start, 10))
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("ETag", `"`+sp.meta.ID+"-"+strconv.Itoa(i)+`"`)
	if r.Header.Get("Range") != "" {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, f.Size))
		w.WriteHeader(206)
	} else {
		w.WriteHeader(200)
	}
	if err := sp.readFile(r, w, i, start, end); err != nil {
		slog.Warn("download interrupted", "space", sp.meta.ID, "file", i, "error", err)
		panic(http.ErrAbortHandler)
	}
	if r.URL.Query().Get("native") == "1" && start == 0 && end == f.Size {
		sp.finishNative(r.URL.Query().Get("claim"))
	}
}

func (a *application) archive(w http.ResponseWriter, r *http.Request) {
	sp := a.startRead(w, r)
	if sp == nil {
		return
	}
	defer sp.endRead()
	sp.mu.Lock()
	files := append([]fileMeta(nil), sp.meta.Files...)
	sp.mu.Unlock()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="quickfile.zip"`)
	w.Header().Set("X-Accel-Buffering", "no")
	z := zip.NewWriter(w)
	for i, f := range files {
		out, err := z.CreateHeader(&zip.FileHeader{Name: fmt.Sprintf("%d/%s", i+1, f.Name), Method: zip.Store})
		if err == nil {
			err = sp.readFile(r, out, i, 0, f.Size)
		}
		if err != nil {
			slog.Warn("archive interrupted", "space", sp.meta.ID, "error", err)
			panic(http.ErrAbortHandler)
		}
	}
	if err := z.Close(); err != nil {
		slog.Warn("finish archive", "error", err)
		panic(http.ErrAbortHandler)
	}
	if r.URL.Query().Get("native") == "1" {
		sp.finishNative(r.URL.Query().Get("claim"))
	}
}

func (sp *space) finishNative(token string) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if c := sp.meta.Claims[hashToken(token)]; c != nil && sp.live() {
		old := *c
		c.Finished = true
		if err := sp.save(); err != nil {
			*c = old
			slog.Error("save native download completion", "space", sp.meta.ID, "error", err)
		}
	}
}

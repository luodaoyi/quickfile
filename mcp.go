package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpRequestKey struct{}
type mcpRequestInfo struct{ public, api string }

type mcpSpaceInput struct {
	SpaceID string `json:"spaceId" jsonschema:"Space ID returned by create_space or share_file (48 hex characters)."`
}
type mcpFileInput struct {
	Name string `json:"name"`
	Size int64  `json:"size" jsonschema:"File size in bytes, at most 10 GiB."`
}
type mcpCreateInput struct {
	Files        []mcpFileInput `json:"files"`
	Hours        int            `json:"hours,omitempty" jsonschema:"Retention: 1, 2, 6, 12 or 24 hours. Default 24."`
	MaxDownloads int            `json:"maxDownloads,omitempty" jsonschema:"Pickup limit: 1, 5, 10, 20, 50 or 100. Default 100."`
}
type mcpUploadInput struct {
	SpaceID   string `json:"spaceId"`
	FileIndex int    `json:"fileIndex" jsonschema:"Zero-based file index."`
	Owner     string `json:"owner" jsonschema:"Upload credential returned by create_space. Keep private."`
	Offset    int64  `json:"offset" jsonschema:"Confirmed uploaded byte count; start at 0."`
	Data      string `json:"dataBase64" jsonschema:"Standard Base64 of one nonempty chunk, at most 4194304 decoded bytes."`
}
type mcpClaimInput struct {
	SpaceID string `json:"spaceId"`
	Token   string `json:"token,omitempty" jsonschema:"Reuse a 48-hex claim token for idempotent retries. Omit to generate a new pickup."`
}
type mcpClaimCredential struct {
	SpaceID string `json:"spaceId"`
	Claim   string `json:"claim" jsonschema:"Claim token returned by claim_space."`
}
type mcpDownloadInput struct {
	SpaceID   string `json:"spaceId"`
	FileIndex int    `json:"fileIndex"`
	Claim     string `json:"claim"`
	Offset    int64  `json:"offset,omitempty"`
	Length    int64  `json:"length,omitempty" jsonschema:"Omit for a streaming HTTP download URL. Set to read this many bytes as Base64; 4 MiB chunks are recommended."`
}
type mcpShareInput struct {
	Name         string  `json:"name"`
	Text         *string `json:"text,omitempty" jsonschema:"UTF-8 file contents. Supply exactly one of text and dataBase64."`
	Data         *string `json:"dataBase64,omitempty" jsonschema:"Standard Base64 file contents. For large local files use create_space and upload_chunk or HTTP PATCH."`
	Hours        int     `json:"hours,omitempty"`
	MaxDownloads int     `json:"maxDownloads,omitempty"`
}

// Internal calls use the actual listening address, never a client-supplied Host.
var mcpHTTPClient = &http.Client{Transport: &http.Transport{}}

func publicBase(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func mcpHTTP(ctx context.Context, method, path string, body []byte, headers http.Header) (*http.Response, error) {
	info := ctx.Value(mcpRequestKey{}).(mcpRequestInfo)
	req, err := http.NewRequestWithContext(ctx, method, info.api+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = headers
	resp, err := mcpHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}
	defer resp.Body.Close()
	detail, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("HTTP %d: %w", resp.StatusCode, err)
	}
	return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
}

func mcpJSON(ctx context.Context, method, path string, input any, credential string) (map[string]any, error) {
	var body []byte
	if input != nil {
		var err error
		body, err = json.Marshal(input)
		if err != nil {
			return nil, err
		}
	}
	headers := http.Header{"Content-Type": {"application/json"}}
	if credential != "" {
		headers.Set("Authorization", "Bearer "+credential)
	}
	resp, err := mcpHTTP(ctx, method, path, body, headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return map[string]any{"status": "ok"}, nil
	}
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func mcpSpacePath(id string) (string, error) {
	if !validID.MatchString(id) {
		return "", fmt.Errorf("invalid spaceId: expected 48 hexadecimal characters")
	}
	return "/api/spaces/" + id, nil
}

func mcpAddTool[In any](server *mcp.Server, name, description string, readOnly bool, run func(context.Context, In) (any, error)) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: readOnly}},
		func(ctx context.Context, _ *mcp.CallToolRequest, input In) (*mcp.CallToolResult, any, error) {
			out, err := run(ctx, input)
			return nil, out, err
		})
}

func mcpCreate(ctx context.Context, input mcpCreateInput) (map[string]any, error) {
	result, err := mcpJSON(ctx, "POST", "/api/spaces", input, "")
	if err != nil {
		return nil, err
	}
	id := result["space"].(map[string]any)["id"].(string)
	info := ctx.Value(mcpRequestKey{}).(mcpRequestInfo)
	result["shareUrl"] = info.public + "/s/" + id
	result["uploadUrlTemplate"] = info.public + "/api/spaces/" + id + "/files/{fileIndex}"
	return result, nil
}

func mcpUpload(ctx context.Context, input mcpUploadInput) (any, error) {
	path, err := mcpSpacePath(input.SpaceID)
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(input.Data)
	if err != nil {
		return nil, fmt.Errorf("invalid dataBase64: %w", err)
	}
	resp, err := mcpHTTP(ctx, "PATCH", path+"/files/"+strconv.Itoa(input.FileIndex), data, http.Header{
		"Authorization": {"Bearer " + input.Owner},
		"Upload-Offset": {strconv.FormatInt(input.Offset, 10)},
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func (a *application) mcpHandler() http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "Quickfile", Version: version}, &mcp.ServerOptions{
		Instructions: "Public file sharing; no account, API key or OAuth. Read quickfile://mcp/index for setup and API details. " +
			"Use share_file for text or small binary files. For large/local files create_space, then upload_chunk or HTTP PATCH; never pass a client filesystem path to this remote service. " +
			"Share only shareUrl. Keep owner private. Claim once, reuse the claim for all ranges, heartbeat while active, complete_download after saving. " +
			"Files are stored unencrypted on the server and expire after 24 hours or 100 pickups by default.",
	})
	mcpAddTool(server, "health", "GET /healthz: service health and build version.", true, func(ctx context.Context, _ struct{}) (any, error) {
		return mcpJSON(ctx, "GET", "/healthz", nil, "")
	})
	mcpAddTool(server, "create_space", "POST /api/spaces: create a multi-file share and immediately return shareUrl, owner and chunkSize. Upload bytes separately; recipients can start before upload completes.", false, func(ctx context.Context, in mcpCreateInput) (any, error) {
		return mcpCreate(ctx, in)
	})
	mcpAddTool(server, "get_space", "GET /api/spaces/{id}: inspect files, confirmed upload offsets, expiry and pickup count. No credential required.", true, func(ctx context.Context, in mcpSpaceInput) (any, error) {
		path, err := mcpSpacePath(in.SpaceID)
		if err != nil {
			return nil, err
		}
		return mcpJSON(ctx, "GET", path, nil, "")
	})
	mcpAddTool(server, "upload_chunk", "PATCH /api/spaces/{id}/files/{index}: append one Base64 chunk using owner and the exact confirmed offset. Max 4 MiB decoded. On HTTP 409 inspect get_space and resume; do not recreate the share.", false, mcpUpload)
	mcpAddTool(server, "share_file", "Create and upload one text or small Base64 file in one call; returns the share link and private owner credential. Supply exactly one content field. Use create_space/upload_chunk for larger files.", false, func(ctx context.Context, in mcpShareInput) (any, error) {
		if (in.Text == nil) == (in.Data == nil) {
			return nil, fmt.Errorf("supply exactly one of text and dataBase64")
		}
		var data []byte
		if in.Text != nil {
			data = []byte(*in.Text)
		} else {
			var err error
			data, err = base64.StdEncoding.DecodeString(*in.Data)
			if err != nil {
				return nil, fmt.Errorf("invalid dataBase64: %w", err)
			}
		}
		input := mcpCreateInput{Hours: in.Hours, MaxDownloads: in.MaxDownloads}
		input.Files = []mcpFileInput{{Name: in.Name, Size: int64(len(data))}}
		result, err := mcpCreate(ctx, input)
		if err != nil {
			return nil, err
		}
		sp := result["space"].(map[string]any)
		id, owner := sp["id"].(string), result["owner"].(string)
		for offset := 0; offset < len(data); offset += int(chunkSize) {
			_, err := mcpUpload(ctx, mcpUploadInput{SpaceID: id, Owner: owner, Offset: int64(offset), Data: base64.StdEncoding.EncodeToString(data[offset:min(offset+int(chunkSize), len(data))])})
			if err != nil {
				return nil, fmt.Errorf("share upload failed; resume spaceId=%s owner=%s shareUrl=%s: %w", id, owner, result["shareUrl"], err)
			}
		}
		sp, err = mcpJSON(ctx, "GET", "/api/spaces/"+id, nil, "")
		if err != nil {
			return nil, err
		}
		result["space"] = sp
		return result, nil
	})
	mcpAddTool(server, "claim_space", "POST /api/spaces/{id}/claims: reserve one pickup. Returns claim token. Reuse this token across all files, ranges and retries; omitting token makes a NEW pickup.", false, func(ctx context.Context, in mcpClaimInput) (any, error) {
		path, err := mcpSpacePath(in.SpaceID)
		if err != nil {
			return nil, err
		}
		if in.Token == "" {
			in.Token, err = randomID()
			if err != nil {
				return nil, err
			}
		}
		out, err := mcpJSON(ctx, "POST", path+"/claims", map[string]string{"token": in.Token}, "")
		if err != nil {
			return nil, err
		}
		out["claim"] = in.Token
		return out, nil
	})
	for _, operation := range []struct{ name, path, description string }{
		{"heartbeat", "heartbeat", "POST heartbeat: keep an active claim alive. Call at least every 20 seconds while receiving or waiting for uploaded data."},
		{"complete_download", "complete", "POST complete: mark the pickup finished after saving all files. This can trigger permanent deletion when the pickup limit is reached."},
	} {
		mcpAddTool(server, operation.name, operation.description, false, func(ctx context.Context, in mcpClaimCredential) (any, error) {
			path, err := mcpSpacePath(in.SpaceID)
			if err != nil {
				return nil, err
			}
			return mcpJSON(ctx, "POST", path+"/"+operation.path, nil, in.Claim)
		})
	}
	mcpAddTool(server, "download_file", "GET /api/spaces/{id}/files/{index}: returns a streaming download URL; optionally set length to receive a byte range as Base64. A read waits for not-yet-uploaded bytes. Reuse the same claim and complete_download after saving.", false, func(ctx context.Context, in mcpDownloadInput) (any, error) {
		path, err := mcpSpacePath(in.SpaceID)
		if err != nil {
			return nil, err
		}
		if in.Offset < 0 || in.Length < 0 || in.FileIndex < 0 {
			return nil, fmt.Errorf("fileIndex, offset and length must be nonnegative")
		}
		path += "/files/" + strconv.Itoa(in.FileIndex)
		if in.Length == 0 {
			if in.Offset != 0 {
				return nil, fmt.Errorf("length is required when offset is set")
			}
			if err := a.mcpCheckClaim(in.SpaceID, in.Claim, in.FileIndex); err != nil {
				return nil, err
			}
			return map[string]any{"url": ctx.Value(mcpRequestKey{}).(mcpRequestInfo).public + path + "?claim=" + url.QueryEscape(in.Claim), "completion": "Call complete_download after all files are saved."}, nil
		}
		if in.Length-1 > int64(^uint64(0)>>1)-in.Offset {
			return nil, fmt.Errorf("byte range overflow")
		}
		resp, err := mcpHTTP(ctx, "GET", path, nil, http.Header{"Authorization": {"Bearer " + in.Claim}, "Range": {fmt.Sprintf("bytes=%d-%d", in.Offset, in.Offset+in.Length-1)}})
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(data), "offset": in.Offset, "bytes": len(data), "contentRange": resp.Header.Get("Content-Range")}, nil
	})
	mcpAddTool(server, "download_archive", "GET /api/spaces/{id}/archive: return an authenticated streaming ZIP download URL for all files. Save the URL with an HTTP client, then call complete_download. ZIP bytes are streamed over HTTP rather than inserted into the model context.", true, func(ctx context.Context, in mcpClaimCredential) (any, error) {
		path, err := mcpSpacePath(in.SpaceID)
		if err != nil {
			return nil, err
		}
		if err := a.mcpCheckClaim(in.SpaceID, in.Claim, -1); err != nil {
			return nil, err
		}
		return map[string]any{"url": ctx.Value(mcpRequestKey{}).(mcpRequestInfo).public + path + "/archive?claim=" + url.QueryEscape(in.Claim)}, nil
	})
	mcpAddTool(server, "get_signaling_info", "GET /api/spaces/{id}/ws: discover the WebSocket signaling endpoint and protocol for a WebRTC client. MCP does not tunnel persistent WebSocket connections; the client must open this URL itself.", true, func(ctx context.Context, in mcpSpaceInput) (any, error) {
		path, err := mcpSpacePath(in.SpaceID)
		if err != nil {
			return nil, err
		}
		if _, err := mcpJSON(ctx, "GET", path, nil, ""); err != nil {
			return nil, err
		}
		base := ctx.Value(mcpRequestKey{}).(mcpRequestInfo).public
		return map[string]any{"urlTemplate": "ws" + strings.TrimPrefix(base, "http") + path + "/ws?role={sender|receiver}&token={owner|claim}", "messages": "Server: peer notification. Relay: {type: offer|answer|ice, peer: destination peer id, data: SDP or ICE payload}. See peer.js for the file data-channel protocol.", "clientSource": base + "/peer.js"}, nil
	})
	server.AddResource(&mcp.Resource{URI: "quickfile://mcp/index", Name: "Quickfile MCP setup and API guide", MIMEType: "text/plain"}, func(ctx context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		text, err := mcpGuide(ctx.Value(mcpRequestKey{}).(mcpRequestInfo).public)
		if err != nil {
			return nil, err
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: "quickfile://mcp/index", MIMEType: "text/plain", Text: text}}}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, PropagateRequestCancellation: true,
		// Same 4 MiB binary chunk as REST, plus Base64 expansion and REST's 1 MiB JSON metadata allowance.
		MaxRequestBodyBytes: int64(base64.StdEncoding.EncodedLen(int(chunkSize))) + (1 << 20),
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			a.mcpIndex(w, r)
			return
		}
		address := r.Context().Value(http.LocalAddrContextKey).(net.Addr).String()
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if host == "0.0.0.0" {
			host = "127.0.0.1"
		}
		if host == "::" {
			host = "::1"
		}
		ctx := context.WithValue(r.Context(), mcpRequestKey{}, mcpRequestInfo{publicBase(r), "http://" + net.JoinHostPort(host, port)})
		handler.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *application) mcpCheckClaim(id, token string, index int) error {
	sp := a.store.get(id)
	if sp == nil {
		return errGone
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.live() || sp.authorizedClaim(token) == nil {
		return fmt.Errorf("claim expired or completed")
	}
	if index >= len(sp.meta.Files) {
		return fmt.Errorf("file not found")
	}
	return nil
}

func mcpGuide(base string) (string, error) {
	data, err := frontend.ReadFile("web/mcp.txt")
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(string(data), "{{BASE_URL}}", base), nil
}

func (a *application) mcpIndex(w http.ResponseWriter, r *http.Request) {
	text, err := mcpGuide(publicBase(r))
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, text)
}

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type peer struct {
	conn *websocket.Conn
	send chan any
}

func (a *application) socket(w http.ResponseWriter, r *http.Request) {
	sp := a.find(w, r)
	if sp == nil {
		return
	}
	sp.mu.Lock()
	role, token := r.URL.Query().Get("role"), r.URL.Query().Get("token")
	id := hashToken(token)
	if !sp.live() || (role == "sender" && !sp.owner(token)) || (role != "sender" && sp.authorizedClaim(token) == nil) {
		sp.mu.Unlock()
		writeError(w, 403, "invalid connection credential")
		return
	}
	if role == "sender" {
		id = "sender"
	}
	sp.mu.Unlock()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(64 << 10)
	p := &peer{conn: conn, send: make(chan any, 32)}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.CloseNow()
	sp.mu.Lock()
	if old := sp.peers[id]; old != nil {
		old.conn.CloseNow()
	}
	sp.peers[id] = p
	sp.notify()
	if id == "sender" {
		for other := range sp.peers {
			if other != "sender" {
				p.enqueue(map[string]string{"type": "peer", "peer": other})
			}
		}
	} else if sender := sp.peers["sender"]; sender != nil {
		sender.enqueue(map[string]string{"type": "peer", "peer": id})
	}
	sp.mu.Unlock()
	defer func() {
		sp.mu.Lock()
		if sp.peers[id] == p {
			delete(sp.peers, id)
			sp.notify()
		}
		sp.mu.Unlock()
	}()
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case <-sp.done:
				return
			case message := <-p.send:
				body, err := json.Marshal(message)
				if err != nil {
					slog.Error("encode signal", "error", err)
					return
				}
				writeCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err = conn.Write(writeCtx, websocket.MessageText, body)
				done()
				if err != nil {
					return
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		conn.CloseNow()
	}()
	for {
		_, body, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg struct {
			Type string          `json:"type"`
			Peer string          `json:"peer"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(body, &msg); err != nil || !oneSignal(msg.Type) {
			continue
		}
		sp.mu.Lock()
		if !sp.live() || (id != "sender" && sp.authorizedClaim(token) == nil) {
			sp.mu.Unlock()
			return
		}
		target := "sender"
		if id == "sender" {
			target = msg.Peer
		}
		if dest := sp.peers[target]; dest != nil && target != id {
			dest.enqueue(map[string]any{"type": msg.Type, "peer": id, "data": msg.Data})
		}
		sp.mu.Unlock()
	}
}

func oneSignal(t string) bool {
	return t == "offer" || t == "answer" || t == "ice"
}

func (p *peer) enqueue(message any) {
	select {
	case p.send <- message:
	default:
		p.conn.CloseNow()
	}
}

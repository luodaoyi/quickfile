package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

//go:embed web/*
var frontend embed.FS

var version = "dev"

func main() {
	addr := flag.String("listen", env("QUICKFILE_LISTEN", ":8080"), "HTTP listen address")
	data := flag.String("data", env("QUICKFILE_DATA", "./data"), "persistent data directory")
	printVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *printVersion {
		println(version)
		return
	}
	store, err := openStore(*data)
	if err != nil {
		slog.Error("open data directory", "error", err)
		os.Exit(1)
	}
	assets, err := fs.Sub(frontend, "web")
	if err != nil {
		slog.Error("open embedded frontend", "error", err)
		os.Exit(1)
	}
	app := &application{store: store, assets: http.FileServerFS(assets)}
	server := &http.Server{Addr: *addr, Handler: app.routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go store.cleanLoop(ctx)
	go func() {
		<-ctx.Done()
		store.shutdown()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			slog.Error("HTTP shutdown", "error", err)
		}
	}()
	slog.Info("Quickfile ready", "version", version, "listen", *addr, "data", *data)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("HTTP server", "error", err)
		os.Exit(1)
	}
}

func env(name, value string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return value
}

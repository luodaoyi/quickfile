package main

import (
	"fmt"
	"html"
	"log/slog"
	"net/http"
)

func (a *application) index(w http.ResponseWriter, r *http.Request) {
	private := r.PathValue("id") != ""
	if private {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	data := struct {
		BaseURL string
		Version string
		Private bool
	}{publicBase(r), version, private}
	if err := a.homepage.ExecuteTemplate(w, "index.html", data); err != nil {
		slog.Warn("render homepage", "error", err)
	}
}

func (a *application) robots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "User-agent: *\nDisallow: /api/\nDisallow: /downloads/\nSitemap: %s/sitemap.xml\n", publicBase(r))
}

func (a *application) sitemap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	fmt.Fprintf(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"><url><loc>%s/</loc></url></urlset>\n", html.EscapeString(publicBase(r)))
}

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// config holds runtime configuration from environment variables.
type config struct {
	Port              string
	KeepaliveMargin   int
	DefaultInactivity int
	SessionTTL        int
	MaxSessions       int
}

var cfg = config{
	Port:              envStr("PORT", "8080"),
	KeepaliveMargin:   envInt("KEEPALIVE_MARGIN", 10),
	DefaultInactivity: envInt("DEFAULT_INACTIVITY", 60),
	SessionTTL:        envInt("SESSION_TTL", 86400),
	MaxSessions:       envInt("MAX_SESSIONS", 1000),
}

var registry = newRegistry()

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /sessions", rateLimited(handleCreateSession))
	mux.HandleFunc("GET /sessions/{token}", handleGetSession)
	mux.HandleFunc("DELETE /sessions/{token}", handleDeleteSession)

	addr := ":" + cfg.Port
	log.Printf("bosh-proxy listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// handleHealth returns a simple liveness response.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"sessions": registry.count(),
	})
}

// handleCreateSession registers a new BOSH keepalive session.
func handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if registry.count() >= cfg.MaxSessions {
		writeJSON(w, http.StatusServiceUnavailable, errResp("server at session capacity"))
		return
	}

	var req struct {
		BoshURL string `json:"bosh_url"`
		SID     string `json:"sid"`
		RID     int64  `json:"rid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errResp("invalid JSON"))
		return
	}
	if req.BoshURL == "" || req.SID == "" || req.RID <= 0 {
		writeJSON(w, http.StatusBadRequest, errResp("bosh_url, sid, and rid are required"))
		return
	}
	if !strings.HasPrefix(req.BoshURL, "http://") && !strings.HasPrefix(req.BoshURL, "https://") {
		writeJSON(w, http.StatusBadRequest, errResp("bosh_url must be http or https"))
		return
	}

	token, err := registry.add(req.BoshURL, req.SID, req.RID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errResp("failed to create session"))
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"token": token})
}

// handleGetSession returns the current keepalive state for a session.
func handleGetSession(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	s := registry.get(token)
	if s == nil {
		writeJSON(w, http.StatusNotFound, errResp("session not found"))
		return
	}

	s.mu.Lock()
	resp := map[string]any{
		"sid":        s.SID,
		"rid":        s.RID,
		"bosh_url":   s.BoshURL,
		"last_poll":  s.LastPoll.Format(time.RFC3339),
		"active":     s.Active,
		"created_at": s.CreatedAt.Format(time.RFC3339),
	}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, resp)
}

// handleDeleteSession stops the keepalive and removes the session.
func handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if !registry.remove(token) {
		writeJSON(w, http.StatusNotFound, errResp("session not found"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- rate limiting ---

type rateLimiter struct {
	mu      sync.Mutex
	counts  map[string][]time.Time
	window  time.Duration
	maxReqs int
}

var limiter = &rateLimiter{
	counts:  make(map[string][]time.Time),
	window:  time.Minute,
	maxReqs: 5,
}

func rateLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr
		if i := strings.LastIndex(ip, ":"); i != -1 {
			ip = ip[:i]
		}
		if !limiter.allow(ip) {
			writeJSON(w, http.StatusTooManyRequests, errResp("rate limit exceeded"))
			return
		}
		next(w, r)
	}
}

func (rl *rateLimiter) allow(ip string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	times := rl.counts[ip]
	cutoff := now.Add(-rl.window)
	filtered := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) >= rl.maxReqs {
		rl.counts[ip] = filtered
		return false
	}
	rl.counts[ip] = append(filtered, now)
	return true
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errResp(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}


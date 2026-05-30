package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"
)

// Session holds the keepalive state for one BOSH session.
type Session struct {
	BoshURL    string
	SID        string
	RID        int64
	Inactivity int // seconds, from server's <body inactivity="N">
	LastPoll   time.Time
	Active     bool
	CreatedAt  time.Time
	cancel     context.CancelFunc
	mu         sync.Mutex
}

// Registry manages all active sessions.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func newRegistry() *Registry {
	r := &Registry{sessions: make(map[string]*Session)}
	go r.sweeper()
	return r
}

func (r *Registry) count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.sessions)
}

// add registers a new session and starts its keepalive goroutine.
func (r *Registry) add(boshURL, sid string, rid int64) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		BoshURL:    boshURL,
		SID:        sid,
		RID:        rid,
		Inactivity: cfg.DefaultInactivity,
		Active:     true,
		CreatedAt:  time.Now(),
		LastPoll:   time.Now(),
		cancel:     cancel,
	}

	r.mu.Lock()
	r.sessions[token] = s
	r.mu.Unlock()

	go s.keepalive(ctx, token, r)
	return token, nil
}

// get returns the session for a token, or nil if not found.
func (r *Registry) get(token string) *Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sessions[token]
}

// remove stops and deletes a session.
func (r *Registry) remove(token string) bool {
	r.mu.Lock()
	s, ok := r.sessions[token]
	if ok {
		delete(r.sessions, token)
	}
	r.mu.Unlock()
	if ok {
		s.cancel()
	}
	return ok
}

// keepalive runs the periodic BOSH poll loop for a session.
func (s *Session) keepalive(ctx context.Context, token string, r *Registry) {
	interval := time.Duration(s.Inactivity-cfg.KeepaliveMargin) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	calibrated := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			inactivity, terminated, err := poll(s)
			if err != nil {
				log.Printf("[%s] poll error: %v", token[:8], err)
				continue
			}
			if terminated {
				log.Printf("[%s] server terminated session", token[:8])
				s.mu.Lock()
				s.Active = false
				s.mu.Unlock()
				r.mu.Lock()
				delete(r.sessions, token)
				r.mu.Unlock()
				return
			}
			// Calibrate interval from first server response.
			if !calibrated && inactivity > 0 {
				calibrated = true
				newInterval := time.Duration(inactivity-cfg.KeepaliveMargin) * time.Second
				if newInterval > 0 && newInterval != interval {
					ticker.Reset(newInterval)
					interval = newInterval
					s.mu.Lock()
					s.Inactivity = inactivity
					s.mu.Unlock()
				}
			}
		}
	}
}

// sweeper removes sessions that have been idle longer than SESSION_TTL.
func (r *Registry) sweeper() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		ttl := time.Duration(cfg.SessionTTL) * time.Second
		r.mu.Lock()
		for token, s := range r.sessions {
			s.mu.Lock()
			idle := time.Since(s.LastPoll) > ttl
			s.mu.Unlock()
			if idle {
				s.cancel()
				delete(r.sessions, token)
				log.Printf("[%s] session expired", token[:8])
			}
		}
		r.mu.Unlock()
	}
}

func randomToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

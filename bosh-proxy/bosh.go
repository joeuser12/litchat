package main

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	reInactivity = regexp.MustCompile(`inactivity="(\d+)"`)
	reTerminate  = regexp.MustCompile(`type="terminate"`)
	reCondition  = regexp.MustCompile(`condition="([^"]+)"`)
)

var boshHTTPClient = &http.Client{Timeout: 15 * time.Second}

// poll sends one empty BOSH keepalive request for the session.
// Returns the inactivity value from the server response (0 if not present),
// whether the server terminated the session, and any transport error.
func poll(s *Session) (inactivity int, terminated bool, err error) {
	s.mu.Lock()
	rid := s.RID
	s.RID++
	sid := s.SID
	boshURL := s.BoshURL
	s.mu.Unlock()

	body := fmt.Sprintf(`<body rid="%d" sid="%s" xmlns="http://jabber.org/protocol/httpbind"/>`, rid, sid)

	req, err := http.NewRequest(http.MethodPost, boshURL, strings.NewReader(body))
	if err != nil {
		s.mu.Lock()
		s.RID-- // roll back
		s.mu.Unlock()
		return 0, false, err
	}
	req.Header.Set("Content-Type", "text/xml")

	resp, err := boshHTTPClient.Do(req)
	if err != nil {
		s.mu.Lock()
		s.RID-- // roll back on network failure
		s.mu.Unlock()
		return 0, false, err
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return 0, false, err
	}
	respBody := string(respBytes)

	if m := reInactivity.FindStringSubmatch(respBody); m != nil {
		inactivity, _ = strconv.Atoi(m[1])
	}

	if reTerminate.MatchString(respBody) {
		condition := ""
		if m := reCondition.FindStringSubmatch(respBody); m != nil {
			condition = m[1]
		}
		_ = condition
		return inactivity, true, nil
	}

	s.mu.Lock()
	s.LastPoll = time.Now()
	s.mu.Unlock()

	return inactivity, false, nil
}

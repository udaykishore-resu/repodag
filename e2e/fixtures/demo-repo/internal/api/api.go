package api

import "example.com/demo/internal/store"

// Serve pretends to serve the store.
func Serve(s *store.Store) string { return s.Name }

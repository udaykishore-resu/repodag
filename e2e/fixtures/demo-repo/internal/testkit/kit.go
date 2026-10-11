package testkit

import (
	"example.com/demo/internal/api"
	"example.com/demo/internal/store"
)

// Store returns a store for tests. It uses api, and api's external test package (package api_test) uses this
// package in turn. Go allows that, because api_test is not api: it must not be drawn as a cycle.
func Store() *store.Store {
	_ = api.Serve
	return store.Open()
}

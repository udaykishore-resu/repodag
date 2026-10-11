package api_test

import (
	"testing"

	"example.com/demo/internal/api"
	"example.com/demo/internal/testkit"
)

func TestServe(t *testing.T) {
	if api.Serve(testkit.Store()) == "" {
		t.Fatal("empty")
	}
}

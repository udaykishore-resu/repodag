package core

import "github.com/google/uuid"

// Name is not an import: "example.com/poly/internal/testutil"
func Name() string { return uuid.NewString() }

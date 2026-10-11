package core

import (
	"testing"

	"example.com/poly/internal/testutil"
)

func TestName(t *testing.T) { testutil.Check(t, Name()) }

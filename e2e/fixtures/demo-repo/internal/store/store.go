package store

import "github.com/google/uuid"

type Store struct{ Name string }

func Open() *Store { return &Store{Name: uuid.NewString()} }

package main

import (
	"fmt"

	"example.com/demo/internal/api"
	"example.com/demo/internal/store"
)

func main() {
	fmt.Println(api.Serve(store.Open()))
}

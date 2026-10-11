// Command app wires the pieces together.
package main

import (
	"fmt"

	"example.com/poly/internal/core"
	gen "example.com/poly/tools/gen"
	_ "example.com/poly/vendor/lib" // lives in an ignored folder
)

func main() { fmt.Println(core.Name(), gen.Version) }

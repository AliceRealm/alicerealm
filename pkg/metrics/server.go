package metrics

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func StartMetricsServer(port int) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(Registry, promhttp.HandlerOpts{}))
	addr := fmt.Sprintf(":%d", port)
	if bindAddress := strings.TrimSpace(os.Getenv("SERVICE_BIND_ADDRESS")); bindAddress != "" {
		addr = net.JoinHostPort(bindAddress, strconv.Itoa(port))
	}
	log.Printf("metrics server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("metrics server error: %v", err)
	}
}

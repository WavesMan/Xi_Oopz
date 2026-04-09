package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"oopz/internal/app"
	"oopz/internal/config"
	"oopz/internal/realtime"
)

// main 加载环境配置并启动 HTTP 服务。
func main() {
	if err := config.LoadDotEnv(".env"); err != nil {
		log.Fatalf("load .env: %v", err)
	}

	cfg := config.Load()

	application, err := app.New(cfg)
	if err != nil {
		log.Fatalf("init app: %v", err)
	}
	defer application.Close()

	hub := realtime.NewHub(application.Store, application.Redis, application.Auth)

	router := gin.Default()
	app.RegisterRoutes(router, application, hub)
	app.RegisterStatic(router)

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: router,
	}

	log.Printf("oopz listening on http://localhost:%s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("server stopped: %v", err)
		os.Exit(1)
	}
}

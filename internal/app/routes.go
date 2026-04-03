package app

import (
	"os"

	"github.com/gin-gonic/gin"

	"oopz/internal/httpapi"
	"oopz/internal/realtime"
)

func RegisterRoutes(router *gin.Engine, application *App, hub *realtime.Hub) {
	handler := httpapi.NewHandler(application.Store, hub, application.Auth, application.Redis, application.Mailer)

	router.GET("/healthz", handler.Healthz)
	router.GET("/api/domains", handler.ListDomains)
	router.POST("/api/domains", handler.CreateDomain)
	router.POST("/api/auth/send-verification-code", handler.SendVerificationCode)
	router.POST("/api/auth/register", handler.Register)
	router.POST("/api/auth/login", handler.Login)
	router.GET("/api/auth/me", handler.Me)
	router.POST("/api/users/guest", handler.CreateGuestUser)
	router.GET("/api/bootstrap", handler.Bootstrap)
	router.GET("/api/domains/:domainId", handler.GetDomain)
	router.PATCH("/api/domains/:domainId", handler.UpdateDomain)
	router.GET("/api/domains/:domainId/members", handler.DomainMembers)
	router.GET("/api/domains/:domainId/channels", handler.DomainChannels)
	router.GET("/api/domains/:domainId/presence", handler.DomainPresence)
	router.POST("/api/domains/:domainId/categories", handler.CreateCategory)
	router.POST("/api/domains/:domainId/channels", handler.CreateChannel)
	router.GET("/api/domains/:domainId/channels/:channelId/messages", handler.ChannelMessages)
	router.PATCH("/api/channels/:channelId", handler.UpdateChannel)
	router.GET("/ws", handler.ServeWS)
}

func RegisterStatic(router *gin.Engine) {
	if _, err := os.Stat("./frontend/dist"); err == nil {
		router.Static("/assets", "./frontend/dist/assets")
		router.GET("/", func(c *gin.Context) {
			c.File("./frontend/dist/index.html")
		})
		return
	}

	router.Static("/assets", "./web/assets")
	router.GET("/", func(c *gin.Context) {
		c.File("./web/index.html")
	})
}

package app

import (
	"time"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"

	"oopz/internal/auth"
	"oopz/internal/config"
	"oopz/internal/notify"
	"oopz/internal/store"
)

type App struct {
	DB     *gorm.DB
	Redis  *redis.Client
	Store  *store.Store
	Auth   *auth.TokenManager
	Mailer *notify.Mailer
	Config config.Config
}

func New(cfg config.Config) (*App, error) {
	db, err := store.OpenMySQL(cfg.MySQLDSN)
	if err != nil {
		return nil, err
	}

	rdb, err := store.OpenRedis(cfg.RedisAddr, cfg.RedisPassword)
	if err != nil {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
		return nil, err
	}

	s := store.New(db)
	if err := s.Migrate(); err != nil {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
		_ = rdb.Close()
		return nil, err
	}
	if err := s.EnsureSeedData(); err != nil {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
		_ = rdb.Close()
		return nil, err
	}

	return &App{
		DB:     db,
		Redis:  rdb,
		Store:  s,
		Auth:   auth.NewTokenManager(cfg.AuthSecret, 7*24*time.Hour),
		Mailer: notify.NewMailer(cfg),
		Config: cfg,
	}, nil
}

func (a *App) Close() {
	if a.Redis != nil {
		_ = a.Redis.Close()
	}
	if a.DB != nil {
		if sqlDB, err := a.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
}

package notify

import (
	"bytes"
	"fmt"
	"net/smtp"
	"strings"

	"oopz/internal/config"
)

type Mailer struct {
	enabled  bool
	host     string
	port     string
	user     string
	password string
	fromName string
}

func NewMailer(cfg config.Config) *Mailer {
	return &Mailer{
		enabled:  cfg.EmailEnabled,
		host:     cfg.EmailHost,
		port:     cfg.EmailPort,
		user:     cfg.EmailUser,
		password: cfg.EmailPassword,
		fromName: cfg.EmailFromName,
	}
}

func (m *Mailer) Enabled() bool {
	return m != nil && m.enabled
}

func (m *Mailer) SendVerificationCode(emailAddress, code string) error {
	if !m.Enabled() {
		return nil
	}
	if strings.TrimSpace(m.host) == "" || strings.TrimSpace(m.port) == "" || strings.TrimSpace(m.user) == "" || strings.TrimSpace(m.password) == "" {
		return fmt.Errorf("email env missing")
	}

	from := m.user
	addr := fmt.Sprintf("%s:%s", m.host, m.port)
	auth := smtp.PlainAuth("", m.user, m.password, m.host)

	var body bytes.Buffer
	body.WriteString(fmt.Sprintf("From: %s <%s>\r\n", m.fromName, from))
	body.WriteString(fmt.Sprintf("To: %s\r\n", emailAddress))
	body.WriteString("Subject: Oopz Live 邮箱验证码\r\n")
	body.WriteString("MIME-Version: 1.0\r\n")
	body.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	body.WriteString("\r\n")
	body.WriteString(fmt.Sprintf("<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;\">你的验证码：<h1 style=\"letter-spacing:0.12em;\">%s</h1><p>5 分钟内有效。</p></div>", code))

	return smtp.SendMail(addr, auth, from, []string{emailAddress}, body.Bytes())
}

package erp

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// User 登录账号。账号注册表固定钉在默认仓（aosidi 的 erp.db），
// 切仓不会把人登出，也不允许各分仓各存一份账号。
type User struct {
	ID           int
	Username     string
	PasswordHash string
	Name         string
	Role         string
	IsActive     bool
	PublicKey    string
	Fingerprint  string
}

const userColumns = "id, username, password_hash, name, role, is_active, public_key, fingerprint"

func scanUser(scan func(dest ...any) error) (*User, error) {
	var u User
	var pw, name, role, publicKey, fingerprint sql.NullString
	var isActive sql.NullInt64
	err := scan(&u.ID, &u.Username, &pw, &name, &role, &isActive, &publicKey, &fingerprint)
	if err != nil {
		return nil, err
	}
	u.PasswordHash = pw.String
	u.Name = name.String
	u.Role = role.String
	if u.Role == "" {
		u.Role = "user"
	}
	u.IsActive = isActive.Int64 != 0
	u.PublicKey = publicKey.String
	u.Fingerprint = fingerprint.String
	return &u, nil
}

// GetUserByUsername 按用户名精确查找（大小写敏感，与 Python 一致）。
func GetUserByUsername(ctx context.Context, q Querier, username string) (*User, error) {
	row := q.QueryRowContext(ctx, "SELECT "+userColumns+" FROM users WHERE username = ?", username)
	u, err := scanUser(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// GetUserByID 按 id 查找（会话令牌里只放 uid）。
func GetUserByID(ctx context.Context, q Querier, id int) (*User, error) {
	row := q.QueryRowContext(ctx, "SELECT "+userColumns+" FROM users WHERE id = ?", id)
	u, err := scanUser(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// UserJSON 登录态接口返回的用户字段（不含任何凭证信息）。
func (u *User) UserJSON() map[string]any {
	return map[string]any{"id": u.ID, "username": u.Username, "name": u.Name, "role": u.Role}
}

// IsAdmin 是否管理员（分仓等敏感操作要求）。
func (u *User) IsAdmin() bool { return strings.EqualFold(u.Role, "admin") }


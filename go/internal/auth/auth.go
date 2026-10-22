package auth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 本包复刻 Python 端 app/auth.py + app/keys.py 的会话令牌与私钥指纹算法，
// 让 Go 与 Python 共用同一份 data/.secret 与 users 表：在一边签发的登录令牌，
// 切到另一边（网关回源或整体迁移后）依然有效。

// CookieName 会话 cookie 名（与 Python COOKIE_NAME 一致）。
const CookieName = "erp_token"

// TokenMaxAge 会话有效期（7 天，与 Python TOKEN_MAX_AGE 一致）。
const TokenMaxAge = 60 * 60 * 24 * 7

// sshKeyMagic OpenSSH 私钥文件魔数（结尾是一个 NUL 字节）。
var sshKeyMagic = []byte("openssh-key-v1\x00")

// Payload 令牌载荷：uid + 本会话所属分仓 wh + 过期时间 exp。
// 用普通字符串字面量写 tag，保持与 Python json.dumps(dict) 的键名一致。
type Payload struct {
	UID int    "json:\"uid\""
	WH  string "json:\"wh\""
	Exp int64  "json:\"exp\""
}

// SecretStore 管理 data/.secret（与 Python 共用同一份密钥文件，两边令牌互认）。
type SecretStore struct {
	dir    string
	cached []byte
}

// NewSecretStore 管理 data/.secret（32 字节随机密钥，首次运行自动生成）。
func NewSecretStore(dataDir string) *SecretStore { return &SecretStore{dir: dataDir} }

// Secret 返回会话签名密钥；文件缺失时生成，长度异常时报错（避免用坏密钥签令牌）。
func (s *SecretStore) Secret() ([]byte, error) {
	if len(s.cached) == 32 {
		return s.cached, nil
	}
	path := filepath.Join(s.dir, ".secret")
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		if err := os.MkdirAll(s.dir, 0o755); err != nil {
			return nil, err
		}
		raw = make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return nil, err
		}
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("data/.secret 长度异常（%d 字节），请删除该文件后重启服务重新生成", len(raw))
	}
	s.cached = raw
	return raw, nil
}

// MakeToken 签发会话令牌：base64url(JSON) + "." + hmac_sha256_hex，
// 且去掉 base64 的 "=" 填充（cookie 值里不出现 "="，避免浏览器/代理给值加引号后取不到）。
// 与 Python make_token 逐字节一致，同一 secret 下两边互认。
func MakeToken(sec []byte, uid int, warehouse string) (string, error) {
	payload, err := json.Marshal(Payload{UID: uid, WH: warehouse, Exp: time.Now().Unix() + int64(TokenMaxAge)})
	if err != nil {
		return "", err
	}
	raw := strings.TrimRight(base64.URLEncoding.EncodeToString(payload), "=")
	mac := hmac.New(sha256.New, sec)
	mac.Write([]byte(raw))
	return raw + "." + hex.EncodeToString(mac.Sum(nil)), nil
}

// DecodeToken 校验签名与有效期并返回载荷；非法/过期返回 nil。兼容带 "=" 填充的历史令牌。
func DecodeToken(sec []byte, token string) *Payload {
	if token == "" || len(sec) == 0 {
		return nil
	}
	i := strings.LastIndex(token, ".")
	if i <= 0 {
		return nil
	}
	raw, sig := token[:i], token[i+1:]
	mac := hmac.New(sha256.New, sec)
	mac.Write([]byte(raw))
	expect := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expect)) != 1 {
		return nil
	}
	padded := raw + strings.Repeat("=", (4-len(raw)%4)%4)
	body, err := base64.URLEncoding.DecodeString(padded)
	if err != nil {
		return nil
	}
	var p Payload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil
	}
	if p.Exp < time.Now().Unix() || p.UID == 0 {
		return nil
	}
	return &p
}

// ---------------- 口令校验（PBKDF2-HMAC-SHA256，与 Python hash_password 同格式） ----------------

// VerifyPassword 校验 "salt$hexdk" 格式的口令散列（种子账号/管理员口令）。
// Python 端登录只走私钥指纹；这里额外支持口令，是为了让安卓端不必在手机里管理私钥文件，
// 散列格式与 users.password_hash 完全兼容（同一账号两边都能用）。
func VerifyPassword(password, stored string) bool {
	salt, dk, ok := strings.Cut(stored, "$")
	if !ok || salt == "" || dk == "" {
		return false
	}
	want, err := hex.DecodeString(dk)
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), []byte(salt), 100000, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// HashPassword 生成 "salt$hexdk"，供 Go 侧建账号/改口令使用。
func HashPassword(password string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	salt := hex.EncodeToString(b)
	dk := pbkdf2SHA256([]byte(password), []byte(salt), 100000, 32)
	return salt + "$" + hex.EncodeToString(dk)
}

// pbkdf2SHA256 标准 PBKDF2（hmac-sha256）实现，避免引入额外依赖。
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	blocks := (keyLen + sha256.Size - 1) / sha256.Size
	out := make([]byte, 0, blocks*sha256.Size)
	be := make([]byte, 4)
	for block := 1; block <= blocks; block++ {
		binary.BigEndian.PutUint32(be, uint32(block))
		mac := hmac.New(sha256.New, password)
		mac.Write(append(append([]byte{}, salt...), be...))
		u := mac.Sum(nil)
		t := append([]byte{}, u...)
		for i := 1; i < iter; i++ {
			mac.Reset()
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// ---------------- Ed25519 OpenSSH 私钥 → 公钥指纹 ----------------

var errOpenSSHKey = errors.New("私钥无法解析，请确认是 Ed25519 私钥文件内容")

// FingerprintFromPrivate 由 OpenSSH 私钥文本推导 (公钥 OpenSSH 文本, SHA256 指纹)。
// 口径与 Python keys.public_from_private 一致：指纹取公钥 wire 段（base64）的 SHA256，再 base64 去尾 "="。
func FingerprintFromPrivate(privatePEM string) (string, string, error) {
	body, err := decodeOpenSSHPem(privatePEM)
	if err != nil {
		return "", "", err
	}
	if !bytes.HasPrefix(body, sshKeyMagic) {
		return "", "", errOpenSSHKey
	}
	p := &cursor{data: body, off: len(sshKeyMagic)}
	cipherName, err := p.str()
	if err != nil {
		return "", "", err
	}
	kdfName, err := p.str()
	if err != nil {
		return "", "", err
	}
	if _, err := p.str(); err != nil { // kdfoptions
		return "", "", err
	}
	nKeys, err := p.uint32()
	if err != nil {
		return "", "", err
	}
	if nKeys != 1 {
		return "", "", fmt.Errorf("仅支持单密钥私钥文件（当前含 %d 个密钥）", nKeys)
	}
	pubBlob, err := p.bytes()
	if err != nil {
		return "", "", err
	}
	if cipherName != "none" || kdfName != "none" {
		return "", "", errors.New("暂不支持带口令的私钥，请使用无口令 Ed25519 私钥")
	}
	privSection, err := p.rest()
	if err != nil {
		return "", "", err
	}
	q := &cursor{data: privSection}
	if _, err := q.uint32(); err != nil { // check1
		return "", "", errOpenSSHKey
	}
	if _, err := q.uint32(); err != nil { // check2
		return "", "", errOpenSSHKey
	}
	keyBlob, err := q.bytes()
	if err != nil {
		return "", "", errOpenSSHKey
	}
	k := &cursor{data: keyBlob}
	typ, err := k.str()
	if err != nil {
		return "", "", errOpenSSHKey
	}
	if typ != "ssh-ed25519" {
		return "", "", errors.New("仅支持 Ed25519 私钥（ssh-ed25519）")
	}
	if _, err := k.bytes(); err != nil { // 公钥
		return "", "", errOpenSSHKey
	}
	if _, err := k.bytes(); err != nil { // 私钥 64 字节（seed+pub）
		return "", "", errOpenSSHKey
	}
	pubKey, err := ed25519PubFromBlob(pubBlob)
	if err != nil {
		return "", "", err
	}
	publicSSH := "ssh-ed25519 " + base64.StdEncoding.EncodeToString(pubBlob) + " 企业台账"
	sum := sha256.Sum256(pubKey)
	fingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
	return publicSSH, fingerprint, nil
}

func ed25519PubFromBlob(blob []byte) ([]byte, error) {
	k := &cursor{data: blob}
	typ, err := k.str()
	if err != nil {
		return nil, err
	}
	if typ != "ssh-ed25519" {
		return nil, errors.New("仅支持 Ed25519 公钥")
	}
	pk, err := k.bytes()
	if err != nil {
		return nil, err
	}
	if len(pk) != ed25519.PublicKeySize {
		return nil, errOpenSSHKey
	}
	return pk, nil
}

// decodeOpenSSHPem 取出 BEGIN/END 之间的 base64 并解码。
func decodeOpenSSHPem(text string) ([]byte, error) {
	s := strings.TrimSpace(text)
	if !strings.HasPrefix(s, "-----BEGIN") {
		return nil, errors.New("未识别的私钥格式：请完整粘贴 OpenSSH 私钥内容（以 BEGIN OPENSSH PRIVATE KEY 开头）")
	}
	if strings.Contains(s, "ENCRYPTED") {
		return nil, errors.New("暂不支持带口令的私钥，请使用无口令 Ed25519 私钥")
	}
	nl := strings.IndexByte(s, byte('\n'))
	if nl < 0 {
		return nil, errOpenSSHKey
	}
	end := strings.Index(s, "-----END")
	if end < 0 {
		return nil, errOpenSSHKey
	}
	b64 := strings.Join(strings.Fields(s[nl:end]), "")
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errOpenSSHKey
	}
	return raw, nil
}

// cursor 是 SSH wire 格式读取器（RFC 4251：uint32 长度前缀）。
type cursor struct {
	data []byte
	off  int
}

func (c *cursor) uint32() (uint32, error) {
	if c.off+4 > len(c.data) {
		return 0, errOpenSSHKey
	}
	v := binary.BigEndian.Uint32(c.data[c.off:])
	c.off += 4
	return v, nil
}

func (c *cursor) bytes() ([]byte, error) {
	n, err := c.uint32()
	if err != nil {
		return nil, err
	}
	if c.off+int(n) > len(c.data) {
		return nil, errOpenSSHKey
	}
	v := c.data[c.off : c.off+int(n)]
	c.off += int(n)
	return v, nil
}

func (c *cursor) str() (string, error) {
	b, err := c.bytes()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (c *cursor) rest() ([]byte, error) {
	if c.off > len(c.data) {
		return nil, errOpenSSHKey
	}
	return c.data[c.off:], nil
}


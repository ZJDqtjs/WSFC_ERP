"""SSH 指纹认证：Ed25519 密钥对生成、私钥解析、公钥指纹计算。

- 密钥使用 OpenSSH 格式（-----BEGIN OPENSSH PRIVATE KEY-----），
  可用 ssh-keygen / PuTTY 等工具识别。
- 服务器只保存公钥与 SHA256 指纹，私钥仅在生成/重新生成时一次性返回下载。
"""
import base64
import hashlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_ssh_private_key,
)


def _serialize_public(public_key) -> str:
    """公钥序列化为 OpenSSH 单行文本，如 ssh-ed25519 AAAA... 注释。"""
    body = public_key.public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH).decode()
    return f"{body} 企业台账"


def fingerprint(public_key_openssh: str) -> str:
    """OpenSSH 指纹：SHA256 摘要后 Base64（去尾 =）。形如 SHA256:xxxx。"""
    try:
        wire = base64.b64decode(public_key_openssh.strip().split()[1])
    except (IndexError, ValueError):
        raise ValueError("公钥格式不正确")
    digest = hashlib.sha256(wire).digest()
    b32 = base64.b64encode(digest).rstrip(b"=").decode()
    return "SHA256:" + b32


def generate_keypair() -> tuple[str, str, str]:
    """生成 Ed25519 密钥对。

    返回 (私钥 PEM 文本, 公钥 OpenSSH 文本, 指纹)。
    """
    key = Ed25519PrivateKey.generate()
    private_pem = key.private_bytes(Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption()).decode()
    public_ssh = _serialize_public(key.public_key())
    return private_pem, public_ssh, fingerprint(public_ssh)


def parse_private(private_pem: str) -> Ed25519PrivateKey:
    """解析 OpenSSH/PEM 私钥文本（Ed25519）。"""
    try:
        key = load_ssh_private_key(private_pem.strip().encode(), password=None)
    except Exception as e:  # noqa: BLE001 只支持 Ed25519，其余类型视为不可用
        raise ValueError("私钥无法解析，请确认是 Ed25519 私钥文件内容") from e
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("仅支持 Ed25519 私钥（ssh-ed25519）")
    return key


def public_from_private(private_pem: str) -> tuple[str, str]:
    """由私钥推导公钥与指纹。

    返回 (公钥 OpenSSH 文本, 指纹)。
    """
    key = parse_private(private_pem)
    public_ssh = _serialize_public(key.public_key())
    return public_ssh, fingerprint(public_ssh)

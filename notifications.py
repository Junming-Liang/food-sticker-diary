"""Web Push keys and validation for opt-in buddy notifications."""
import base64
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def valid_endpoint(endpoint):
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or any(ord(c) <= 32 for c in endpoint):
        return False
    try:
        url = urlsplit(endpoint)
        host = url.hostname or ''
        allowed = host in ('fcm.googleapis.com', 'updates.push.services.mozilla.com') or bool(
            re.fullmatch(r'(?:[a-z0-9-]+\.)+push\.apple\.com', host))
        return (url.scheme == 'https' and allowed and not url.username and not url.password and
                url.port in (None, 443) and bool(url.path and url.path != '/') and not url.fragment)
    except ValueError:
        return False


def _decode_key(value, length):
    if (not isinstance(value, str) or len(value)!=(length*8+5)//6 or
            not re.fullmatch(r'[A-Za-z0-9_-]+', value)):
        raise ValueError('通知订阅格式不正确')
    try:
        decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise ValueError('通知订阅格式不正确') from exc
    if len(decoded) != length: raise ValueError('通知订阅格式不正确')
    return decoded


def validate_subscription(value):
    if not isinstance(value, dict) or not valid_endpoint(value.get('endpoint')):
        raise ValueError('通知服务地址不受支持')
    keys = value.get('keys')
    if not isinstance(keys, dict): raise ValueError('通知订阅格式不正确')
    public = _decode_key(keys.get('p256dh'), 65)
    _decode_key(keys.get('auth'), 16)
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
    except ValueError as exc:
        raise ValueError('通知订阅格式不正确') from exc
    return {'endpoint': value['endpoint'], 'keys': {'p256dh': keys['p256dh'], 'auth': keys['auth']}}


def vapid_key_path(data_dir):
    """Create the shared key atomically; concurrent app and worker startups reuse it."""
    path = Path(data_dir) / 'vapid-private.pem'
    if path.exists(): return path
    key = ec.generate_private_key(ec.SECP256R1())
    encoded = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
    temporary = path.with_name('.vapid-' + secrets.token_hex(12))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output: output.write(encoded)
        try: os.link(temporary, path)
        except FileExistsError: pass
    finally:
        temporary.unlink(missing_ok=True)
    return path


def vapid_public_key(data_dir):
    key = serialization.load_pem_private_key(vapid_key_path(data_dir).read_bytes(), password=None)
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(public).rstrip(b'=').decode()

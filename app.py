"""Food Sticker Diary: authenticated meal journal and opt-in sharing."""
import base64
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash
import ai

# minimal: one lock protects image creation/deletion and thumbnail publication.
_image_lock = threading.RLock()


def serialized_images(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with _image_lock:
            return function(*args, **kwargs)
    return wrapped


ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('FOOD_DATA', ROOT / 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
UPLOADS = DATA / 'images'
UPLOADS.mkdir(exist_ok=True, mode=0o700)
KEY_FILE = DATA / 'secret.key'
if not KEY_FILE.exists():
    try:
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as key_file: key_file.write(Fernet.generate_key())
    except FileExistsError:
        pass
cipher = Fernet(KEY_FILE.read_bytes())
_base = os.environ.get('FOOD_BASE', '/food-diary/').strip('/')
BASE = '/' + (_base + '/' if _base else '')
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024
app.config['SESSION_COOKIE_SECURE'] = os.environ.get('FOOD_COOKIE_SECURE', '1') != '0'


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DATA / 'diary.sqlite3', timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys = ON')
    return g.db


@app.teardown_appcontext
def close_db(exc):
    if 'db' in g: g.db.close()


def initialize():
    with app.app_context():
        db().executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password TEXT NOT NULL, target INTEGER NOT NULL DEFAULT 1800,
            provider TEXT NOT NULL DEFAULT 'local', model TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
            created INTEGER NOT NULL, carbs_goal REAL, protein_goal REAL, fat_goal REAL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_settings (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK(provider IN ('openai','deepseek')),
            model TEXT NOT NULL, api_key TEXT NOT NULL, PRIMARY KEY(user_id,provider)
        );
        CREATE TABLE IF NOT EXISTS meals (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL,
            grams REAL NOT NULL, calories REAL NOT NULL, carbs REAL NOT NULL, protein REAL NOT NULL, fat REAL NOT NULL,
            image TEXT, sticker TEXT, created INTEGER NOT NULL,
            components TEXT NOT NULL DEFAULT '[]', sticker_rendered TEXT,
            sticker_border INTEGER NOT NULL DEFAULT 0, sticker_color TEXT NOT NULL DEFAULT '#ffffff'
        );
        CREATE INDEX IF NOT EXISTS meals_user_day ON meals(user_id,day);
        CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_cipher TEXT NOT NULL,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS buddy_pairs (
            id TEXT PRIMARY KEY, created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS buddy_members (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            pair_id TEXT NOT NULL REFERENCES buddy_pairs(id) ON DELETE CASCADE,
            sharing INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS buddy_invites (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS water (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(user_id, day)
        );
        CREATE TABLE IF NOT EXISTS exercises (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL, name TEXT NOT NULL, minutes INTEGER NOT NULL,
            calories REAL NOT NULL, created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS exercises_user_day ON exercises(user_id,day);
        CREATE TABLE IF NOT EXISTS fasts (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            started INTEGER NOT NULL, ended INTEGER, goal_hours INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS fasts_one_active ON fasts(user_id) WHERE ended IS NULL;
        CREATE TABLE IF NOT EXISTS weights (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(user_id, day)
        );
        ''')
        columns={row['name'] for row in db().execute('PRAGMA table_info(meals)').fetchall()}
        if 'components' not in columns:
            db().execute("ALTER TABLE meals ADD COLUMN components TEXT NOT NULL DEFAULT '[]'")
        for name,definition in (('sticker_rendered','TEXT'),('sticker_border','INTEGER NOT NULL DEFAULT 0'),
                                ('sticker_color',"TEXT NOT NULL DEFAULT '#ffffff'")):
            if name not in columns: db().execute(f'ALTER TABLE meals ADD COLUMN {name} {definition}')
        user_columns={row['name'] for row in db().execute('PRAGMA table_info(users)').fetchall()}
        for name in ('carbs_goal','protein_goal','fat_goal'):
            if name not in user_columns:
                db().execute(f'ALTER TABLE users ADD COLUMN {name} REAL')
        db().execute('''INSERT OR IGNORE INTO provider_settings(user_id,provider,model,api_key)
                     SELECT id,provider,model,api_key FROM users WHERE provider IN ('openai','deepseek')''')
        db().commit()


@app.before_request
def before():
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        origin = request.headers.get('Origin')
        if origin and (urlsplit(origin).netloc.lower() != request.host.lower() or urlsplit(origin).scheme not in ('http','https')):
            return jsonify(error='请求来源不匹配'), 403
    raw = request.cookies.get('food_session', '')
    g.user = None
    if raw:
        g.user = db().execute('''SELECT users.* FROM sessions JOIN users ON sessions.user_id=users.id
            WHERE sessions.token_hash=? AND sessions.expires>?''', (digest(raw), int(time.time()))).fetchone()


@app.after_request
def security(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return response


@app.errorhandler(413)
def too_large(exc): return jsonify(error='照片太大，请选择小于 12 MB 的图片'), 413


def digest(token): return hashlib.sha256(token.encode()).hexdigest()


def auth(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not g.user: return jsonify(error='请先登录'), 401
        return f(*args, **kwargs)
    return wrapped


def body():
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else {}


def valid_day(value):
    try:
        return date.fromisoformat(value).isoformat() == value
    except (TypeError, ValueError): return False


def public_user(user):
    options={row['provider']:{'model':row['model'],'has_key':bool(row['api_key'])}
             for row in db().execute('SELECT provider,model,api_key FROM provider_settings WHERE user_id=?',(user['id'],))}
    return {'id':user['id'], 'username':user['username'], 'target':user['target'],
            'provider':user['provider'], 'model':user['model'], 'has_key':bool(user['api_key']),
            'provider_options':options,
            'carbs_goal':user['carbs_goal'], 'protein_goal':user['protein_goal'], 'fat_goal':user['fat_goal']}


def issue_session(user):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    db().execute('DELETE FROM sessions WHERE expires<?', (now,))
    db().execute('INSERT INTO sessions VALUES (?,?,?)', (digest(token), user['id'], now + 60*60*24*30))
    db().commit()
    response = jsonify(user=public_user(user))
    response.set_cookie('food_session', token, max_age=60*60*24*30, httponly=True,
                        secure=app.config['SESSION_COOKIE_SECURE'], samesite='Lax', path=BASE)
    return response


_attempts = {}
def auth_rate_limited():
    # minimal: in-memory per-IP limit; move to a shared store if multiple server workers are used.
    now = time.time(); ip = request.headers.get('X-Real-IP', request.remote_addr or '')
    hits = [t for t in _attempts.get(ip, []) if t > now-600]
    _attempts[ip] = hits
    if len(hits) >= 20: return True
    hits.append(now)
    return False


@app.post('/api/auth/register')
def register():
    if auth_rate_limited(): return jsonify(error='操作太频繁，请稍后再试'), 429
    data = body(); username = str(data.get('username', '')).strip(); password = str(data.get('password', ''))
    if not 2 <= len(username) <= 32 or not re.fullmatch(r'[\w\u4e00-\u9fff.\-]+', username):
        return jsonify(error='用户名需为 2 至 32 位，只能包含文字、字母、数字、点或横线'), 400
    if not 8 <= len(password) <= 128: return jsonify(error='密码长度需为 8 至 128 位'), 400
    try:
        cursor = db().execute('INSERT INTO users(username,password,created) VALUES (?,?,?)',
                              (username, generate_password_hash(password), int(time.time())))
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify(error='这个用户名已被使用'), 409
    return issue_session(db().execute('SELECT * FROM users WHERE id=?', (cursor.lastrowid,)).fetchone())


@app.post('/api/auth/login')
def login():
    if auth_rate_limited(): return jsonify(error='操作太频繁，请稍后再试'), 429
    data = body(); username = str(data.get('username','')).strip(); password = str(data.get('password',''))
    user = db().execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    if not user or len(password) > 128 or not check_password_hash(user['password'], password):
        return jsonify(error='用户名或密码不正确'), 401
    return issue_session(user)


@app.post('/api/auth/logout')
@auth
def logout():
    token = request.cookies.get('food_session', '')
    db().execute('DELETE FROM sessions WHERE token_hash=?', (digest(token),)); db().commit()
    response = jsonify(ok=True); response.delete_cookie('food_session', path=BASE)
    return response


@app.get('/api/me')
def me():
    return jsonify(user=public_user(g.user) if g.user else None)


@app.delete('/api/account')
@auth
@serialized_images
def delete_account():
    if auth_rate_limited(): return jsonify(error='操作太频繁，请稍后再试'), 429
    password = str(body().get('password', ''))
    if len(password) > 128 or not check_password_hash(g.user['password'], password):
        return jsonify(error='密码不正确'), 401
    user_id = g.user['id']
    # Remove the image files before deleting the account so an I/O error remains retryable.
    folder = UPLOADS / str(user_id)
    if folder.is_dir(): shutil.rmtree(folder)
    db().execute('DELETE FROM buddy_pairs WHERE id IN (SELECT pair_id FROM buddy_members WHERE user_id=?)', (user_id,))
    db().execute('DELETE FROM users WHERE id=?', (user_id,)); db().commit()
    response = jsonify(ok=True); response.delete_cookie('food_session', path=BASE)
    return response


@app.put('/api/settings')
@auth
def settings():
    data = body()
    db().execute('BEGIN IMMEDIATE')
    current = db().execute('SELECT * FROM users WHERE id=?',(g.user['id'],)).fetchone()
    if not current: abort(401)
    provider = data.get('provider', current['provider'])
    if provider not in ('local', 'openai', 'deepseek'): return jsonify(error='请选择有效的识别服务'), 400
    defaults = {'openai':'gpt-4o-mini', 'deepseek':'deepseek-flash', 'local':''}
    previous = db().execute('SELECT model,api_key FROM provider_settings WHERE user_id=? AND provider=?',
                            (g.user['id'],provider)).fetchone()
    previous_model = current['model'] if provider == current['provider'] else previous['model'] if previous else ''
    model = str(data.get('model', previous_model)).strip()[:100] or defaults[provider]
    if model and not re.fullmatch(r'[\w.\-:]+', model): return jsonify(error='模型名称格式不正确'), 400
    try: target = int(data.get('target', current['target']))
    except (TypeError, ValueError): return jsonify(error='请输入有效的每日目标'), 400
    if not 500 <= target <= 10000: return jsonify(error='每日目标需在 500 至 10000 千卡之间'), 400
    goals=[]
    for name in ('carbs_goal','protein_goal','fat_goal'):
        value=data.get(name,current[name])
        if value in ('',None): goals.append(None); continue
        try: value=float(value)
        except (TypeError,ValueError): return jsonify(error='请输入有效的营养目标'),400
        if not 0.1 <= value <= 2000: return jsonify(error='营养目标需在 0.1 至 2000 克之间'),400
        goals.append(round(value,1))
    raw_key = str(data.get('api_key', '')).strip()
    if len(raw_key)>512 or any(ord(c)<32 for c in raw_key): return jsonify(error='API 密钥格式不正确'), 400
    # Each service keeps its own encrypted key; never send one service another service's key.
    saved_key = current['api_key'] if provider == current['provider'] else previous['api_key'] if previous else ''
    if provider == 'local': saved_key = ''
    if data.get('clear_key'): saved_key = ''
    elif raw_key and provider != 'local': saved_key = cipher.encrypt(raw_key.encode()).decode()
    if provider != 'local':
        db().execute('''INSERT INTO provider_settings(user_id,provider,model,api_key) VALUES(?,?,?,?)
                      ON CONFLICT(user_id,provider) DO UPDATE SET model=excluded.model,api_key=excluded.api_key''',
                     (g.user['id'],provider,model,saved_key))
    db().execute('''UPDATE users SET provider=?,model=?,api_key=?,target=?,
                 carbs_goal=?,protein_goal=?,fat_goal=? WHERE id=?''',
                 (provider,model,saved_key,target,*goals,g.user['id'])); db().commit()
    user = db().execute('SELECT * FROM users WHERE id=?', (g.user['id'],)).fetchone()
    return jsonify(user=public_user(user))


@app.post('/api/settings/check')
@auth
def check_settings():
    if g.user['provider'] != 'openai': return jsonify(error='请先保存 OpenAI 识别设置'),400
    if not g.user['api_key']: return jsonify(error='请先保存 OpenAI API 密钥'),400
    try:
        ai.check_openai_model(cipher.decrypt(g.user['api_key'].encode()).decode(),g.user['model'])
    except ValueError as exc: return jsonify(error=str(exc)),400
    return jsonify(message='连接成功，当前项目可以查看所选模型；实际识别还取决于额度和模型权限。')


def clean_image(file):
    if not file: raise ValueError('请选择食物照片')
    try:
        Image.MAX_IMAGE_PIXELS = 24_000_000
        image = Image.open(file)
        if image.width * image.height > 8_000_000:
            raise ValueError('照片尺寸过大，请选择较小的图片')
        if image.format not in ('JPEG','PNG','WEBP'):
            raise ValueError('请选择 JPG、PNG 或 WebP 照片')
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.thumbnail((1280,1280), Image.Resampling.LANCZOS)
        return image
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
        raise ValueError('无法读取照片，请换一张图片') from exc


# minimal: a single photo job bounds memory on the shared server; a busy user can retry.
_photo_lock = threading.BoundedSemaphore(1)


@app.post('/api/analyze')
@auth
def analyze():
    if not _photo_lock.acquire(blocking=False):
        return jsonify(error='当前正在处理另一张照片，请稍后重试'), 429
    try:
        return analyze_photo()
    finally:
        _photo_lock.release()


def analyze_photo():
    try: image = clean_image(request.files.get('image'))
    except ValueError as exc: return jsonify(error=str(exc)), 400
    # Every photo is reencoded before any storage or external provider request, stripping metadata.
    photo = ai.jpeg_bytes(image)
    result = {'photo':'data:image/jpeg;base64,' + base64.b64encode(photo).decode(), 'sticker':None}
    provider = g.user['provider']
    def collect_sticker(get_result):
        try:
            result['sticker'] = 'data:image/png;base64,' + base64.b64encode(get_result()).decode()
        except (FileNotFoundError, ValueError, RuntimeError):
            result['sticker_error'] = '贴纸暂时无法生成，仍可保存原照片'
    def collect_recognition():
        try:
            if provider in ('openai','deepseek'):
                if not g.user['api_key']: raise ValueError('请先在「我的」中配置 API 密钥')
                key = cipher.decrypt(g.user['api_key'].encode()).decode()
                result['estimate'] = ai.vision_recognize(image, provider, key, g.user['model'])
                result['source'] = provider
            else:
                result['candidates'] = ai.local_recognize(image)
                result['source'] = 'local'
        except FileNotFoundError:
            result['recognition_error'] = '本地识别模型尚未安装，可配置 AI 服务或手动填写'
        except Exception as exc:
            app.logger.warning('Photo recognition failed: %s', type(exc).__name__)
            result['recognition_error'] = str(exc) if isinstance(exc, ValueError) else '识别失败，请检查服务配置后重试'
    if provider in ('openai','deepseek'):
        # minimal: the outer photo lock still allows only one job on the shared server.
        with ThreadPoolExecutor(max_workers=1,thread_name_prefix='food-sticker') as pool:
            sticker = pool.submit(ai.sticker,image.copy())
            collect_recognition()
            collect_sticker(sticker.result)
    else:
        collect_sticker(lambda:ai.sticker(image))
        collect_recognition()
    return jsonify(result)


@app.post('/api/reanalyze')
@auth
def reanalyze():
    if not _photo_lock.acquire(blocking=False):
        return jsonify(error='当前正在处理另一张照片，请稍后重试'),429
    try:
        provider=g.user['provider']
        if provider not in ('openai','deepseek') or not g.user['api_key']:
            return jsonify(error='请先在「我的」中配置视觉识别服务'),400
        hint=request.form.get('hint','').strip()
        if not 1<=len(hint)<=120 or any(ord(c)<32 for c in hint):
            return jsonify(error='请输入 1 至 120 个字的菜名或配料说明'),400
        try:
            image=clean_image(request.files.get('image'))
            key=cipher.decrypt(g.user['api_key'].encode()).decode()
            estimate=ai.vision_recognize(image,provider,key,g.user['model'],hint=hint)
            return jsonify(estimate=estimate,source=provider)
        except ValueError as exc:
            return jsonify(error=str(exc)),400
        except Exception as exc:
            app.logger.warning('Photo recognition retry failed: %s',type(exc).__name__)
            return jsonify(error='识别失败，请检查服务配置后重试'),502
    finally:
        _photo_lock.release()


def meal_fields(data):
    day = str(data.get('day','')); category = str(data.get('category','')); name = str(data.get('name','')).strip()
    if not valid_day(day): raise ValueError('请选择有效的日期')
    if category not in ('breakfast','lunch','dinner','snack'): raise ValueError('请选择餐次')
    if not 1 <= len(name) <= 80: raise ValueError('请输入食物名称')
    values = []
    for field in ('grams','calories','carbs','protein','fat'):
        try: value = float(data.get(field) or 0)
        except (ValueError, TypeError): raise ValueError('请填写有效的营养数值')
        if not 0 <= value <= 100000: raise ValueError('营养数值超出范围')
        values.append(round(value, 1))
    return [day, category, name, *values]


def meal_payload(data):
    components=data.get('components',[])
    if not isinstance(components,list) or len(components)>12:
        raise ValueError('食物明细最多支持 12 项')
    cleaned=[]
    for item in components:
        if not isinstance(item,dict): raise ValueError('请检查食物明细')
        name=str(item.get('name','')).strip()
        if not 1 <= len(name) <= 80: raise ValueError('请填写每一项食物名称')
        entry={'name':name}
        for key in ('grams','calories','carbs','protein','fat'):
            try: value=float(item.get(key) or 0)
            except (TypeError,ValueError): raise ValueError('请检查食物明细的营养数值')
            if not 0 <= value <= 100000: raise ValueError('食物明细数值超出范围')
            entry[key]=round(value,1)
        cleaned.append(entry)
    if cleaned:
        data=dict(data)
        for key in ('grams','calories','carbs','protein','fat'):
            data[key]=round(sum(item[key] for item in cleaned),1)
    return meal_fields(data),cleaned


def thumbnail_bytes(image, kind):
    image = ai.sanitize_sticker(image) if kind == 'sticker' else image.convert('RGB')
    image.thumbnail((384, 384), Image.Resampling.LANCZOS)
    if kind == 'sticker': image = ai.sanitize_sticker(image)
    stream = io.BytesIO()
    if kind == 'sticker': image.save(stream, format='PNG')
    else: image.save(stream, format='JPEG', quality=80, optimize=True)
    return stream.getvalue()


def publish_thumbnail(path, content):
    """Publish an immutable sidecar atomically while coordinating with deletion."""
    target = path.with_name(path.name + '.thumb')
    with _image_lock:
        if not path.is_file(): return None
        if target.is_file(): return target
        if shutil.disk_usage(DATA).free < 2 * 1024**3: return None
        temporary = target.with_name(target.name + '.' + secrets.token_hex(8) + '.tmp')
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output: output.write(content)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return target


def save_image(data_url, user_id, kind):
    if not data_url: return None
    # Leave room for the other services that share this filesystem.
    if shutil.disk_usage(DATA).free < 2 * 1024**3:
        raise ValueError('服务器存储空间不足，暂时无法保存照片')
    expected = 'data:image/jpeg;base64,' if kind == 'photo' else 'data:image/png;base64,'
    if not isinstance(data_url,str) or not data_url.startswith(expected) or len(data_url) > 10_000_000:
        raise ValueError('图片格式不正确')
    try:
        raw = base64.b64decode(data_url[len(expected):], validate=True)
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > 4_000_000: raise ValueError('图片尺寸过大')
        image.load()
        image = image.convert('RGB' if kind == 'photo' else 'RGBA')
        if kind == 'sticker': image = ai.sanitize_sticker(image)
        folder = UPLOADS / str(user_id); folder.mkdir(exist_ok=True, mode=0o700)
        name = secrets.token_hex(16) + ('.jpg' if kind == 'photo' else '.png')
        path = folder / name
        image.save(path, format='JPEG' if kind=='photo' else 'PNG')
        os.chmod(path, 0o600)
        # A missing preview is harmless; existing images are also generated lazily.
        try: publish_thumbnail(path, thumbnail_bytes(image, kind))
        except OSError: app.logger.warning('Could not cache an image preview')
        return name
    except (ValueError, UnidentifiedImageError, OSError) as exc:
        raise ValueError('无法保存照片') from exc


def remove_image(user_id, name):
    if name:
        path = UPLOADS / str(user_id) / Path(name).name
        path.unlink(missing_ok=True)
        path.with_name(path.name + '.thumb').unlink(missing_ok=True)


def meal_json(row, shared=False):
    return {k:row[k] for k in ('id','day','category','name','grams','calories','carbs','protein','fat','created')} | {
        'has_photo':bool(row['image']) and not shared, 'has_sticker':bool(row['sticker']),
        'sticker_border':row['sticker_border'], 'sticker_color':row['sticker_color'],
        'components':json.loads(row['components'])}


@app.get('/api/meals')
@auth
def meals():
    day = request.args.get('day',''); start = request.args.get('start',''); end = request.args.get('end','')
    if valid_day(day): start = end = day
    if not valid_day(start) or not valid_day(end) or start>end:
        return jsonify(error='请选择有效的日期范围'), 400
    rows = db().execute('SELECT * FROM meals WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day DESC,created DESC',
                        (g.user['id'],start,end)).fetchall()
    return jsonify(meals=[meal_json(row) for row in rows])


@app.post('/api/meals')
@auth
@serialized_images
def create_meal():
    data = body()
    try: fields,components = meal_payload(data)
    except ValueError as exc: return jsonify(error=str(exc)), 400
    photo = sticker = None
    try:
        photo = save_image(data.get('photo'),g.user['id'],'photo')
        sticker = save_image(data.get('sticker'),g.user['id'],'sticker')
        mid = secrets.token_hex(16)
        db().execute('''INSERT INTO meals
            (id,user_id,day,category,name,grams,calories,carbs,protein,fat,image,sticker,created,components)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (mid,g.user['id'],*fields,photo,sticker,int(time.time()),json.dumps(components,ensure_ascii=False)))
        db().commit()
    except Exception as exc:
        remove_image(g.user['id'], photo); remove_image(g.user['id'], sticker)
        if isinstance(exc, ValueError): return jsonify(error=str(exc)), 400
        raise
    row = db().execute('SELECT * FROM meals WHERE id=?', (mid,)).fetchone()
    return jsonify(meal=meal_json(row)), 201


@app.put('/api/meals/<mid>')
@auth
def update_meal(mid):
    row = db().execute('SELECT * FROM meals WHERE id=? AND user_id=?', (mid,g.user['id'])).fetchone()
    if not row: abort(404)
    data=body()
    if 'components' not in data and json.loads(row['components']):
        return jsonify(error='此记录含有食物明细，请刷新页面后再编辑'),409
    try: fields,components = meal_payload(data)
    except ValueError as exc: return jsonify(error=str(exc)), 400
    db().execute('''UPDATE meals SET day=?,category=?,name=?,grams=?,calories=?,carbs=?,protein=?,fat=?,components=?
                    WHERE id=? AND user_id=?''', (*fields,json.dumps(components,ensure_ascii=False),mid,g.user['id'])); db().commit()
    return jsonify(meal=meal_json(db().execute('SELECT * FROM meals WHERE id=?',(mid,)).fetchone()))


@app.delete('/api/meals/<mid>')
@auth
@serialized_images
def delete_meal(mid):
    row = db().execute('SELECT * FROM meals WHERE id=? AND user_id=?', (mid,g.user['id'])).fetchone()
    if not row: abort(404)
    db().execute('DELETE FROM meals WHERE id=? AND user_id=?', (mid,g.user['id'])); db().commit()
    remove_image(g.user['id'],row['image']); remove_image(g.user['id'],row['sticker']); remove_image(g.user['id'],row['sticker_rendered'])
    return jsonify(ok=True)


@app.put('/api/meals/<mid>/sticker-style')
@auth
@serialized_images
def update_sticker_style(mid):
    row=db().execute('SELECT * FROM meals WHERE id=? AND user_id=?',(mid,g.user['id'])).fetchone()
    if not row or not row['sticker']: abort(404)
    data=body(); border=data.get('border'); color=data.get('color')
    if type(border) is not int or border not in (0,1,2) or not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color):
        return jsonify(error='请选择有效的贴纸边框和颜色'),400
    color=color.lower(); new_name=None
    if not _photo_lock.acquire(blocking=False): return jsonify(error='当前正在处理另一张照片，请稍后重试'),429
    try:
        if border:
            source=UPLOADS / str(g.user['id']) / Path(row['sticker']).name
            if not source.is_file(): abort(404)
            if shutil.disk_usage(DATA).free < 2 * 1024**3: return jsonify(error='服务器存储空间不足，暂时无法保存贴纸'),400
            with Image.open(source) as image:
                image=ai.sanitize_sticker(image)
                radius=max(1,min(16,round(max(image.size)*(.006 if border==1 else .012))))
                size=(image.width+2*radius,image.height+2*radius)
                alpha=Image.new('L',size,0);alpha.paste(image.getchannel('A'),(radius,radius))
                outline=ai.expand_alpha(alpha,radius)
                rgb=tuple(int(color[i:i+2],16) for i in (1,3,5))
                rendered=Image.new('RGBA',size,(*rgb,0));rendered.putalpha(outline);rendered.alpha_composite(image,(radius,radius))
            new_name=secrets.token_hex(16)+'.png'
            path=UPLOADS / str(g.user['id']) / new_name
            rendered.save(path,format='PNG');os.chmod(path,0o600)
            try: publish_thumbnail(path,thumbnail_bytes(rendered,'sticker'))
            except OSError: app.logger.warning('Could not cache an image preview')
        db().execute('UPDATE meals SET sticker_rendered=?,sticker_border=?,sticker_color=? WHERE id=? AND user_id=?',
                     (new_name,border,color,mid,g.user['id']));db().commit()
    except (OSError,ValueError):
        remove_image(g.user['id'],new_name)
        return jsonify(error='无法保存贴纸，请稍后重试'),400
    except Exception:
        remove_image(g.user['id'],new_name)
        raise
    finally:
        _photo_lock.release()
    remove_image(g.user['id'],row['sticker_rendered'])
    updated=db().execute('SELECT * FROM meals WHERE id=?',(mid,)).fetchone()
    return jsonify(meal=meal_json(updated))


def send_meal_image(row, kind):
    name = (row['sticker_rendered'] or row['sticker']) if kind=='sticker' else row['sticker'] if kind=='sticker-source' else row['image'] if kind=='photo' else None
    if not name: abort(404)
    path = UPLOADS / str(row['user_id']) / Path(name).name
    if not path.is_file(): abort(404)
    if request.args.get('size') == 'thumbnail':
        target = path.with_name(path.name + '.thumb')
        mimetype = 'image/png' if kind in ('sticker','sticker-source') else 'image/jpeg'
        try:
            if not target.is_file():
                with Image.open(path) as image:
                    content = thumbnail_bytes(image, 'sticker' if kind=='sticker-source' else kind)
                try: target = publish_thumbnail(path, content)
                except OSError: target = None
                if target is None: return send_file(io.BytesIO(content), mimetype=mimetype, conditional=False)
            return send_file(target, mimetype=mimetype, conditional=False)
        except (OSError, ValueError): abort(404)
    if kind in ('sticker','sticker-source'):
        # Sanitize on output as well, so legacy files remain unchanged on disk.
        try:
            with Image.open(path) as image:
                stream = io.BytesIO()
                ai.sanitize_sticker(image).save(stream, format='PNG')
                stream.seek(0)
        except (OSError, ValueError): abort(404)
        return send_file(stream, mimetype='image/png', conditional=False)
    return send_file(path, mimetype='image/jpeg', conditional=False)


@app.get('/api/meals/<mid>/<kind>')
@auth
def meal_image(mid,kind):
    row = db().execute('SELECT * FROM meals WHERE id=? AND user_id=?', (mid,g.user['id'])).fetchone()
    if not row: abort(404)
    return send_meal_image(row,kind)


def own_buddy():
    return db().execute('SELECT * FROM buddy_members WHERE user_id=?', (g.user['id'],)).fetchone()


@app.get('/api/buddy')
@auth
def buddy():
    own = own_buddy()
    if not own: return jsonify(paired=False)
    other = db().execute('''SELECT buddy_members.*, users.username, users.target FROM buddy_members
        JOIN users ON users.id=buddy_members.user_id WHERE pair_id=? AND user_id<>?''',
        (own['pair_id'],g.user['id'])).fetchone()
    if not other: return jsonify(paired=False)
    day=request.args.get('day','')
    if not valid_day(day): return jsonify(error='请选择有效的日期'),400
    result = {'paired':True, 'username':other['username'], 'sharing':bool(own['sharing']),
              'other_sharing':bool(other['sharing']), 'target':other['target'] if other['sharing'] else None, 'meals':[]}
    if other['sharing']:
        rows = db().execute('SELECT * FROM meals WHERE user_id=? AND day=? ORDER BY created DESC',
                            (other['user_id'],day)).fetchall()
        result['meals'] = [meal_json(row, shared=True) for row in rows]
    return jsonify(result)


@app.post('/api/buddy/invites')
@auth
def create_buddy_invite():
    if own_buddy(): return jsonify(error='请先解除当前搭子关系'),409
    token = secrets.token_urlsafe(32); now = int(time.time())
    db().execute('DELETE FROM buddy_invites WHERE user_id=? OR expires<?',(g.user['id'],now))
    db().execute('INSERT INTO buddy_invites VALUES (?,?,?)',(digest(token),g.user['id'],now+86400)); db().commit()
    return jsonify(token=token,expires=now+86400)


@app.get('/api/buddy/invites/<token>')
@auth
def inspect_buddy_invite(token):
    if len(token)>100: abort(404)
    row=db().execute('''SELECT users.username,users.id FROM buddy_invites JOIN users ON users.id=buddy_invites.user_id
        WHERE token_hash=? AND expires>?''',(digest(token),int(time.time()))).fetchone()
    if not row: return jsonify(error='邀请链接无效或已过期'),404
    if row['id']==g.user['id']: return jsonify(error='不能接受自己的邀请'),400
    if own_buddy(): return jsonify(error='请先解除当前搭子关系'),409
    return jsonify(username=row['username'])


@app.post('/api/buddy/accept')
@auth
def accept_buddy():
    token=str(body().get('token',''))
    if len(token)>100: return jsonify(error='邀请链接无效或已过期'),404
    try:
        db().execute('BEGIN IMMEDIATE')
        invite=db().execute('SELECT * FROM buddy_invites WHERE token_hash=? AND expires>?',
                            (digest(token),int(time.time()))).fetchone()
        if not invite:
            db().rollback(); return jsonify(error='邀请链接无效或已过期'),404
        owner=invite['user_id']
        if owner==g.user['id']:
            db().rollback(); return jsonify(error='不能接受自己的邀请'),400
        if db().execute('SELECT 1 FROM buddy_members WHERE user_id IN (?,?)', (owner,g.user['id'])).fetchone():
            db().rollback(); return jsonify(error='你或对方已有搭子，请先解除现有关系'),409
        pair=secrets.token_hex(16)
        db().execute('INSERT INTO buddy_pairs VALUES (?,?)',(pair,int(time.time())))
        db().executemany('INSERT INTO buddy_members(user_id,pair_id,sharing) VALUES (?,?,1)',
                         [(owner,pair),(g.user['id'],pair)])
        db().execute('DELETE FROM buddy_invites WHERE user_id IN (?,?)',(owner,g.user['id']))
        db().commit()
    except sqlite3.IntegrityError:
        db().rollback(); return jsonify(error='搭子关系已变更，请重新邀请'),409
    return jsonify(ok=True)


@app.put('/api/buddy/sharing')
@auth
def buddy_sharing():
    enabled=body().get('enabled')
    if not isinstance(enabled,bool): return jsonify(error='请选择共享状态'),400
    if not own_buddy(): return jsonify(error='还没有绑定搭子'),404
    db().execute('UPDATE buddy_members SET sharing=? WHERE user_id=?',(int(enabled),g.user['id'])); db().commit()
    return jsonify(ok=True)


@app.delete('/api/buddy')
@auth
def delete_buddy():
    own=own_buddy()
    if own:
        db().execute('DELETE FROM buddy_pairs WHERE id=?',(own['pair_id'],)); db().commit()
    return jsonify(ok=True)


@app.get('/api/buddy/meals/<mid>/<kind>')
@auth
def buddy_image(mid,kind):
    if kind != 'sticker': abort(404)
    own=own_buddy()
    if not own: abort(404)
    row=db().execute('''SELECT meals.* FROM meals JOIN buddy_members ON buddy_members.user_id=meals.user_id
       WHERE meals.id=? AND buddy_members.pair_id=? AND buddy_members.user_id<>? AND buddy_members.sharing=1''',
       (mid,own['pair_id'],g.user['id'])).fetchone()
    if not row: abort(404)
    return send_meal_image(row,kind)


@app.route('/api/water', methods=['GET','PUT'])
@auth
def water():
    data = body() if request.method == 'PUT' else request.args
    day = data.get('day','')
    if not valid_day(day): return jsonify(error='请选择有效日期'), 400
    if request.method == 'PUT':
        try: amount = int(data.get('amount',0))
        except (ValueError,TypeError): return jsonify(error='请输入有效的饮水量'),400
        if not 0 <= amount <= 10000: return jsonify(error='饮水量需在 0 至 10000 毫升之间'),400
        db().execute('INSERT INTO water VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET amount=excluded.amount',
                     (g.user['id'],day,amount)); db().commit()
    row = db().execute('SELECT amount FROM water WHERE user_id=? AND day=?',(g.user['id'],day)).fetchone()
    return jsonify(amount=row['amount'] if row else 0)


def exercise_fields(data):
    day=str(data.get('day','')); name=str(data.get('name','')).strip()
    if not valid_day(day): raise ValueError('请选择有效日期')
    if not 1 <= len(name) <= 40: raise ValueError('请输入运动名称')
    try:
        minutes=int(data.get('minutes',0)); calories=float(data.get('calories',0))
    except (TypeError,ValueError): raise ValueError('请填写有效的运动数据')
    if not 1 <= minutes <= 1440 or not 0 <= calories <= 10000:
        raise ValueError('请检查运动时长和消耗热量')
    return day,name,minutes,round(calories,1)


@app.route('/api/exercises', methods=['GET','POST'])
@auth
def exercises():
    if request.method=='POST':
        try: fields=exercise_fields(body())
        except ValueError as exc: return jsonify(error=str(exc)),400
        eid=secrets.token_hex(16)
        db().execute('INSERT INTO exercises VALUES (?,?,?,?,?,?,?)',(eid,g.user['id'],*fields,int(time.time())))
        db().commit()
        return jsonify(ok=True),201
    day=request.args.get('day','')
    if not valid_day(day): return jsonify(error='请选择有效日期'),400
    rows=db().execute('SELECT id,day,name,minutes,calories,created FROM exercises WHERE user_id=? AND day=? ORDER BY created DESC',
                      (g.user['id'],day)).fetchall()
    return jsonify(exercises=[dict(row) for row in rows])


@app.route('/api/exercises/<eid>', methods=['PUT','DELETE'])
@auth
def exercise_detail(eid):
    row=db().execute('SELECT * FROM exercises WHERE id=? AND user_id=?',(eid,g.user['id'])).fetchone()
    if not row: abort(404)
    if request.method=='DELETE':
        db().execute('DELETE FROM exercises WHERE id=? AND user_id=?',(eid,g.user['id']))
    else:
        try: fields=exercise_fields(body())
        except ValueError as exc: return jsonify(error=str(exc)),400
        db().execute('UPDATE exercises SET day=?,name=?,minutes=?,calories=? WHERE id=? AND user_id=?',
                     (*fields,eid,g.user['id']))
    db().commit()
    return jsonify(ok=True)


@app.route('/api/fasts', methods=['GET','POST'])
@auth
def fasts():
    if request.method=='POST':
        try: hours=int(body().get('goal_hours',0))
        except (ValueError,TypeError): return jsonify(error='请选择有效的计时时长'),400
        if hours not in (12,14,16,18): return jsonify(error='请选择有效的计时时长'),400
        try:
            db().execute('INSERT INTO fasts VALUES (?,?,?,?,?)',
                         (secrets.token_hex(16),g.user['id'],int(time.time()),None,hours)); db().commit()
        except sqlite3.IntegrityError:
            db().rollback(); return jsonify(error='已有进行中的计时，请先结束'),409
    rows=db().execute('SELECT id,started,ended,goal_hours FROM fasts WHERE user_id=? ORDER BY started DESC LIMIT 60',
                      (g.user['id'],)).fetchall()
    return jsonify(fasts=[dict(row) for row in rows])


@app.post('/api/fasts/end')
@auth
def end_fast():
    result=db().execute('UPDATE fasts SET ended=MAX(?,started) WHERE user_id=? AND ended IS NULL',
                        (int(time.time()),g.user['id']))
    db().commit()
    if not result.rowcount: return jsonify(error='没有进行中的计时'),404
    return jsonify(ok=True)


@app.delete('/api/fasts/<fid>')
@auth
def delete_fast(fid):
    result=db().execute('DELETE FROM fasts WHERE id=? AND user_id=? AND ended IS NOT NULL',(fid,g.user['id']))
    db().commit()
    if not result.rowcount: return jsonify(error='记录不存在'),404
    return jsonify(ok=True)


@app.route('/api/weights', methods=['GET','POST'])
@auth
def weights():
    if request.method=='POST':
        data = body(); day = data.get('day','')
        try: weight = float(data.get('weight'))
        except (ValueError,TypeError): return jsonify(error='请输入有效的体重'),400
        if not valid_day(day) or not 10 <= weight <= 500: return jsonify(error='请检查日期和体重'),400
        db().execute('INSERT INTO weights VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET weight=excluded.weight',
                     (g.user['id'],day,round(weight,1))); db().commit()
    rows = db().execute('SELECT day,weight FROM weights WHERE user_id=? ORDER BY day DESC LIMIT 60',(g.user['id'],)).fetchall()
    return jsonify(weights=[dict(row) for row in rows])


@app.delete('/api/weights/<day>')
@auth
def delete_weight(day):
    if not valid_day(day): return jsonify(error='请选择有效日期'),400
    result=db().execute('DELETE FROM weights WHERE user_id=? AND day=?',(g.user['id'],day)); db().commit()
    if not result.rowcount: return jsonify(error='记录不存在'),404
    return jsonify(ok=True)


@app.route('/api/shares', methods=['GET','POST'])
@auth
def shares():
    now = int(time.time())
    if request.method=='POST':
        data = body(); day = data.get('day','')
        if not valid_day(day): return jsonify(error='请选择有效日期'),400
        token = secrets.token_urlsafe(32); sid = secrets.token_hex(16)
        expires = now + 7*86400
        db().execute('INSERT INTO shares VALUES (?,?,?,?,?,?,?)',
                     (sid,digest(token),cipher.encrypt(token.encode()).decode(),g.user['id'],day,now,expires)); db().commit()
    rows = db().execute('SELECT * FROM shares WHERE user_id=? AND expires>? ORDER BY created DESC', (g.user['id'],now)).fetchall()
    return jsonify(shares=[{'id':row['id'],'day':row['day'],'expires':row['expires'],
                            'token':cipher.decrypt(row['token_cipher'].encode()).decode()} for row in rows])


@app.delete('/api/shares/<sid>')
@auth
def delete_share(sid):
    db().execute('DELETE FROM shares WHERE id=? AND user_id=?', (sid,g.user['id'])); db().commit()
    return jsonify(ok=True)


def shared_row(token):
    if len(token)>100: return None
    return db().execute('SELECT * FROM shares WHERE token_hash=? AND expires>?', (digest(token), int(time.time()))).fetchone()


@app.get('/api/shared/<token>')
def shared(token):
    share = shared_row(token)
    if not share: return jsonify(error='分享链接无效或已过期'),404
    user = db().execute('SELECT username FROM users WHERE id=?', (share['user_id'],)).fetchone()
    rows = db().execute('SELECT * FROM meals WHERE user_id=? AND day=? ORDER BY created DESC',
                        (share['user_id'],share['day'])).fetchall()
    return jsonify(owner=user['username'],day=share['day'],meals=[meal_json(row, shared=True) for row in rows],expires=share['expires'])


@app.get('/api/shared/<token>/image/<mid>/<kind>')
def shared_image(token,mid,kind):
    if kind != 'sticker': abort(404)
    share=shared_row(token)
    if not share: abort(404)
    row=db().execute('SELECT * FROM meals WHERE id=? AND user_id=? AND day=?',
                     (mid,share['user_id'],share['day'])).fetchone()
    if not row: abort(404)
    return send_meal_image(row,kind)


@app.get('/')
def index(): return send_from_directory(ROOT / 'web','index.html')


@app.get('/<path:path>')
def static_files(path):
    if path.startswith('api/'): abort(404)
    return send_from_directory(ROOT / 'web',path)


initialize()

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT','8792')), threaded=True)

import base64, csv, io, json, os, re, secrets, sqlite3, uuid
from datetime import datetime, timezone, date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
try:
    from PIL import Image
except Exception:
    Image = None

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')
DB_PATH = Path(os.getenv('SHOP_DB_PATH', BASE_DIR / 'data' / 'friends_traders.db'))
DATABASE_URL = os.getenv('DATABASE_URL') or os.getenv('SUPABASE_DB_URL')
UPLOAD_DIR = BASE_DIR / 'uploads'
BACKUP_DIR = BASE_DIR / 'backups'
MIGRATIONS_DIR = BASE_DIR / 'migrations'
SEED_FILE = BASE_DIR / 'data' / 'seed_products.json'
LOW_STOCK_THRESHOLD = int(os.getenv('LOW_STOCK_THRESHOLD', '5'))
OWNER_EMAIL = os.getenv('OWNER_EMAIL', 'owner@friendstraders.local').lower()
OWNER_PASSWORD = os.getenv('OWNER_PASSWORD')
GA_MEASUREMENT_ID = os.getenv('GA_MEASUREMENT_ID', '').strip()[:40]
AI_ASSISTANT_ENABLED = os.getenv('AI_ASSISTANT_ENABLED', 'false').lower() == 'true'
ORDER_WEBHOOK_URL = os.getenv('ORDER_WEBHOOK_URL', '').strip()
GROQ_API_KEY = os.getenv('GROQ_API_KEY', '').strip()
GROQ_MODEL = os.getenv('GROQ_MODEL', 'openai/gpt-oss-20b').strip()
GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
AI_REQUEST_TIMEOUT_SECONDS = max(3, min(int(os.getenv('AI_REQUEST_TIMEOUT_SECONDS', '20')), 60))
ALLOWED_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
app.secret_key = os.getenv('SECRET_KEY', secrets.token_hex(32))
_is_production = os.getenv('RENDER') or os.getenv('DATABASE_URL') or os.getenv('FLASK_ENV') == 'production'
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=bool(_is_production),
    MAX_CONTENT_LENGTH=int(os.getenv('MAX_UPLOAD_BYTES', str(12*1024*1024))),
)

def now_iso(): return datetime.now(timezone.utc).isoformat()
def clean(v, limit=5000): return str(v or '').strip()[:limit]
def money(v):
    try: return round(float(v or 0), 2)
    except Exception: return 0.0

_login_attempts = {}
def login_allowed(key):
    now = datetime.now(timezone.utc).timestamp()
    hits = [t for t in _login_attempts.get(key, []) if now - t < 900]
    if len(hits) >= 8: return False
    _login_attempts[key] = hits
    return True
def note_login_attempt(key): _login_attempts.setdefault(key, []).append(datetime.now(timezone.utc).timestamp())

def notify_order_hook(order):
    """Optional server-to-server notification hook; configuration remains in env."""
    if not ORDER_WEBHOOK_URL: return
    try:
        import urllib.request
        payload=json.dumps({'event':'order.created','order_id':order['id'],'total':order['total'],'status':order['order_status']}).encode()
        req=urllib.request.Request(ORDER_WEBHOOK_URL,data=payload,headers={'Content-Type':'application/json'},method='POST')
        urllib.request.urlopen(req,timeout=3).close()
    except Exception: app.logger.warning('Order notification webhook failed')

class PgConn:
    def __init__(self):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except Exception as exc:
            raise RuntimeError('Supabase/Postgres mode needs psycopg. Run: pip install -r requirements.txt') from exc
        self._psycopg = psycopg
        self._con = psycopg.connect(DATABASE_URL, row_factory=dict_row)

    def _sql(self, sql):
        sql = sql.replace('insert or ignore into', 'insert into')
        sql = re.sub(r'\bon conflict\(([^)]+)\) do update set quantity=min\(quantity\+excluded\.quantity,\?\)', r'on conflict(\1) do update set quantity=least(quantity+excluded.quantity,%s)', sql, flags=re.I)
        return sql.replace('?', '%s')

    def execute(self, sql, params=None):
        cur = self._con.execute(self._sql(sql), params or ())
        return cur

    def executescript(self, script):
        with self._con.cursor() as cur:
            for stmt in [s.strip() for s in script.split(';') if s.strip()]:
                if stmt.startswith('--'):
                    continue
                cur.execute(stmt)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type:
            self._con.rollback()
        else:
            self._con.commit()
        self._con.close()


def db():
    if DATABASE_URL:
        return PgConn()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute('pragma foreign_keys=on')
    return con

def one(row): return dict(row) if row else None

def migrate():
    UPLOAD_DIR.mkdir(exist_ok=True); BACKUP_DIR.mkdir(exist_ok=True)
    with db() as con:
        con.execute('create table if not exists schema_migrations (version text primary key, applied_at text not null)')
        if DATABASE_URL:
            return
        done = {r['version'] for r in con.execute('select version from schema_migrations')}
        for p in sorted(MIGRATIONS_DIR.glob('*.sql')):
            if p.name == 'supabase_schema.sql' or p.stem in done: continue
            con.executescript(p.read_text(encoding='utf-8'))
            con.execute('insert into schema_migrations values (?,?)', (p.stem, now_iso()))

def seed():
    with db() as con:
        owner = con.execute("select id,email,password_hash from users where role='owner' order by created_at limit 1").fetchone()
        if owner:
            # A restart must never silently replace an administrator password.
            if owner['email'] != OWNER_EMAIL:
                con.execute('update users set email=?,updated_at=? where id=?', (OWNER_EMAIL, now_iso(), owner['id']))
        else:
            if not OWNER_PASSWORD:
                raise RuntimeError('Set OWNER_PASSWORD before first startup to create the owner account.')
            con.execute('insert into users values (?,?,?,?,?,?,?,?)', (uuid.uuid4().hex, OWNER_EMAIL, generate_password_hash(OWNER_PASSWORD), 'Friends Traders Owner', '03007195451', 'owner', now_iso(), now_iso()))
        
        if DATABASE_URL:
            con.execute("insert into coupons values ('WELCOME5','percent',5,1000,1,%s) on conflict(code) do nothing", (now_iso(),))
            con.execute("insert into coupons values ('MULTAN10','percent',10,5000,1,%s) on conflict(code) do nothing", (now_iso(),))
        else:
            con.execute("insert or ignore into coupons values ('WELCOME5','percent',5,1000,1,?)", (now_iso(),))
            con.execute("insert or ignore into coupons values ('MULTAN10','percent',10,5000,1,?)", (now_iso(),))
        if con.execute('select count(*) c from products').fetchone()['c'] or not SEED_FILE.exists(): return
        for item in json.loads(SEED_FILE.read_text(encoding='utf-8')):
            pid = uuid.uuid4().hex
            con.execute('insert into products values (?,?,?,?,?,?,?,?,?,?,?,?,?)', (pid,item['sku'],item['name'],item['category'],item['category_slug'],item['brand'],item['description'],item['price'],item['discount'],item['stock'],'active',now_iso(),now_iso()))
            con.execute('insert into product_images values (?,?,?,?,?,?)', (uuid.uuid4().hex,pid,item['image_url'],item['name'],1,now_iso()))

def current_user():
    uid = session.get('user_id')
    if not uid: return None
    with db() as con: return one(con.execute('select id,email,name,phone,role,created_at from users where id=?', (uid,)).fetchone())

def require_login():
    u = current_user()
    return (u, None) if u else (None, (jsonify({'error':'Login required.'}), 401))

def require_owner():
    u, e = require_login()
    if e: return None, e
    return (u, None) if u['role'] == 'owner' else (None, (jsonify({'error':'Owner access required.'}), 403))

@app.before_request
def csrf_gate():
    if not session.get('guest_key'): session['guest_key'] = 'guest:' + secrets.token_urlsafe(18)
    if request.method in {'POST','PUT','PATCH','DELETE'} and request.headers.get('X-CSRF-Token') != session.get('csrf_token'):
        return jsonify({'error':'Security token expired. Refresh and try again.'}), 403

@app.after_request
def headers(resp):
    resp.headers['X-Content-Type-Options']='nosniff'; resp.headers['X-Frame-Options']='SAMEORIGIN'; resp.headers['Referrer-Policy']='strict-origin-when-cross-origin'; resp.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=(), payment=()'
    origin = request.headers.get('Origin')
    if origin in {'http://127.0.0.1:5500','http://localhost:5500','http://127.0.0.1:5501','http://localhost:5501','null'}:
        resp.headers['Access-Control-Allow-Origin'] = origin
        resp.headers['Access-Control-Allow-Credentials'] = 'true'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-CSRF-Token'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    return resp

@app.errorhandler(Exception)
def app_error(exc):
    if isinstance(exc, HTTPException):
        return exc
    app.logger.exception(exc)
    return jsonify({'error':'Server error. Please check Render logs or Supabase database setup.'}), 500


def resolve_product_id(con, raw_id):
    raw = clean(raw_id, 120)
    if not raw:
        return None
    row = con.execute('select id from products where id=?', (raw,)).fetchone()
    if row:
        return row['id']
    sku = raw.upper().replace('-', '_')[:48]
    row = con.execute('select id from products where sku=?', (sku,)).fetchone()
    if row:
        return row['id']
    row = con.execute("select id from products where lower(replace(sku,'_','-'))=?", (raw.lower(),)).fetchone()
    return row['id'] if row else None

def product_images_for(con, product_ids):
    if not product_ids:
        return {}
    placeholders = ','.join('?' for _ in product_ids)
    rows = con.execute(f'select product_id,id,url,alt_text,sort_order from product_images where product_id in ({placeholders}) order by product_id,sort_order,id', product_ids).fetchall()
    out = {}
    for row in rows:
        d = dict(row)
        pid = d.pop('product_id')
        out.setdefault(pid, []).append(d)
    return out

def product_features_for(con, product_ids):
    if not product_ids:
        return {}
    placeholders = ','.join('?' for _ in product_ids)
    rows = con.execute(f'select product_id,label,sort_order from product_features where product_id in ({placeholders}) order by product_id,sort_order,id', product_ids).fetchall()
    out = {}
    for row in rows:
        out.setdefault(row['product_id'], []).append(row['label'])
    return out

def save_features(con, pid, raw):
    con.execute('delete from product_features where product_id=?', (pid,))
    parts = [clean(x, 140) for x in re.split(r'[\n|,]+', str(raw or ''))]
    for order, label in enumerate([p for p in parts if p][:12], 1):
        con.execute('insert into product_features values (?,?,?,?,?)', (uuid.uuid4().hex, pid, label, order, now_iso()))

def ensure_runtime_schema():
    with db() as con:
        con.execute('create table if not exists product_features (id text primary key,product_id text not null references products(id) on delete cascade,label text not null,sort_order integer not null default 0,created_at text not null)')
        con.execute('create table if not exists reviews (id text primary key,name text not null,phone text,rating integer not null default 5,message text not null,active integer not null default 1,created_at text not null)')
        con.execute('create table if not exists wishlists (user_id text not null references users(id) on delete cascade,product_id text not null references products(id) on delete cascade,created_at text not null,primary key(user_id,product_id))')
        con.execute('create table if not exists order_status_events (id text primary key,order_id text not null references orders(id) on delete cascade,status text not null,note text,created_at text not null)')
        con.execute('create table if not exists product_reviews (id text primary key,product_id text not null references products(id) on delete cascade,user_id text references users(id),order_id text references orders(id),rating integer not null,message text not null,verified_purchase integer not null default 0,active integer not null default 1,created_at text not null)')

def images(pid):
    with db() as con:
        return product_images_for(con, [pid]).get(pid, [])

def public_product(r, image_map=None, feature_map=None):
    d = dict(r); d['price']=float(d['price']); d['discount']=float(d['discount']); d['final_price']=max(0, round(d['price']-d['discount'],2)); d['low_stock']=d['stock']<=LOW_STOCK_THRESHOLD; d['out_of_stock']=d['stock']<=0; d['images']=(image_map or {}).get(d['id']) if image_map is not None else images(d['id']); d['features']=(feature_map or {}).get(d['id'], []); return d

def hide_duplicate_products():
    """Keep the newest copy when the same product was saved repeatedly."""
    with db() as con:
        rows = con.execute("select id,name,category_slug,updated_at from products where status='active' order by updated_at desc,id desc").fetchall()
        seen = set()
        for row in rows:
            key = (clean(row['name'], 180).lower(), clean(row['category_slug'], 120).lower())
            if key in seen:
                con.execute("update products set status='hidden',updated_at=? where id=?", (now_iso(), row['id']))
            else:
                seen.add(key)

migrate(); ensure_runtime_schema(); seed(); hide_duplicate_products()

@app.get('/')
def home(): return send_from_directory(BASE_DIR, 'index.html')
@app.get('/robots.txt')
def robots(): return Response('User-agent: *\nAllow: /\nSitemap: '+request.url_root.rstrip('/')+'/sitemap.xml\n',mimetype='text/plain')
@app.get('/sitemap.xml')
def sitemap():
    root=request.url_root.rstrip('/')
    with db() as con: rows=con.execute("select id,updated_at from products where status='active'").fetchall()
    items=[f'<url><loc>{root}/</loc></url>']+[f'<url><loc>{root}/?product={r["id"]}</loc><lastmod>{r["updated_at"][:10]}</lastmod></url>' for r in rows]
    return Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+''.join(items)+'</urlset>',mimetype='application/xml')
@app.get('/uploads/<path:p>')
def uploaded(p): return send_from_directory(UPLOAD_DIR, p)
@app.get('/api/health')
def health():
    with db() as con:
        return jsonify({'ok':True,'database':('supabase' if DATABASE_URL else str(DB_PATH)),'products':con.execute('select count(*) c from products').fetchone()['c'],'orders':con.execute('select count(*) c from orders').fetchone()['c'],'storage':('supabase-postgres' if DATABASE_URL else 'sqlite-local; Supabase SQL schema included')})
@app.get('/api/csrf')
def csrf(): session['csrf_token']=secrets.token_urlsafe(32); return jsonify({'csrf_token':session['csrf_token'],'user':current_user()})
@app.get('/api/public-config')
def public_config():
    # This intentionally exposes only configuration state, never a key or provider response.
    return jsonify({'ga_measurement_id':GA_MEASUREMENT_ID or None,'ai_assistant_enabled':AI_ASSISTANT_ENABLED and bool(GROQ_API_KEY)})

@app.post('/api/auth/register')
def register():
    data=request.get_json(silent=True) or {}; email=clean(data.get('email'),180).lower(); pw=str(data.get('password') or ''); name=clean(data.get('name'),120); phone=clean(data.get('phone'),40)
    if '@' not in email or len(pw)<8 or not name: return jsonify({'error':'Name, valid email, and 8 character password are required.'}),400
    try:
        uid=uuid.uuid4().hex
        with db() as con: con.execute('insert into users values (?,?,?,?,?,?,?,?)',(uid,email,generate_password_hash(pw),name,phone,'customer',now_iso(),now_iso()))
        session['user_id']=uid; return jsonify({'user':current_user()})
    except Exception: return jsonify({'error':'Email is already registered.'}),409
@app.post('/api/auth/login')
def login():
    data=request.get_json(silent=True) or {}; email=clean(data.get('email'),180).lower(); pw=str(data.get('password') or '')
    key='login:'+str(request.remote_addr)
    if not login_allowed(key): return jsonify({'error':'Too many attempts. Please try again later.'}),429
    with db() as con: u=con.execute('select * from users where email=?',(email,)).fetchone()
    if not u or not check_password_hash(u['password_hash'], pw): note_login_attempt(key); return jsonify({'error':'Invalid email or password.'}),401
    session['user_id']=u['id']; return jsonify({'user':current_user()})
@app.post('/api/auth/owner-login')
def owner_login():
    data=request.get_json(silent=True) or {}; pw=str(data.get('password') or '')
    key='owner:'+str(request.remote_addr)
    if not login_allowed(key): return jsonify({'error':'Too many attempts. Please try again later.'}),429
    with db() as con: u=con.execute("select * from users where role='owner' order by created_at limit 1").fetchone()
    if not u or not check_password_hash(u['password_hash'], pw): note_login_attempt(key); return jsonify({'error':'Invalid owner password.'}),401
    session['user_id']=u['id']; return jsonify({'user':current_user()})
@app.post('/api/auth/logout')
def logout(): session.pop('user_id',None); return jsonify({'ok':True})
@app.post('/api/auth/forgot-password')
def forgot():
    data=request.get_json(silent=True) or {}; email=clean(data.get('email'),180).lower(); token=secrets.token_urlsafe(24)
    with db() as con:
        u=con.execute('select id from users where email=?',(email,)).fetchone()
        if u: con.execute('insert into password_resets values (?,?,?,?,0)',(uuid.uuid4().hex,u['id'],generate_password_hash(token),now_iso()))
    out={'ok':True,'message':'If that email exists, a reset token was created for the owner to share securely.'}
    if app.debug or os.getenv('SHOW_RESET_TOKEN')=='true': out['reset_token']=token
    return jsonify(out)
@app.post('/api/auth/reset-password')
def reset_password():
    data=request.get_json(silent=True) or {}; token=str(data.get('token') or ''); password=str(data.get('password') or '')
    if len(password)<12: return jsonify({'error':'Use a password with at least 12 characters.'}),400
    with db() as con:
        rows=con.execute('select * from password_resets where used=0 order by created_at desc limit 20').fetchall()
        reset=next((r for r in rows if check_password_hash(r['token'],token)),None)
        if not reset: return jsonify({'error':'Invalid or used reset token.'}),400
        con.execute('update users set password_hash=?,updated_at=? where id=?',(generate_password_hash(password),now_iso(),reset['user_id']))
        con.execute('update password_resets set used=1 where id=?',(reset['id'],))
    return jsonify({'ok':True,'message':'Password updated. Please sign in again.'})
@app.get('/api/me')
def me():
    u=current_user(); add=[]
    if u:
        with db() as con: add=[dict(r) for r in con.execute('select * from addresses where user_id=? order by is_default desc,created_at desc',(u['id'],))]
    return jsonify({'user':u,'addresses':add})
@app.post('/api/addresses')
def add_address():
    u,e=require_login();
    if e: return e
    d=request.get_json(silent=True) or {}; addr=clean(d.get('address'),1200); city=clean(d.get('city'),80) or 'Multan'
    if not addr: return jsonify({'error':'Address is required.'}),400
    with db() as con:
        if d.get('is_default'): con.execute('update addresses set is_default=0 where user_id=?',(u['id'],))
        con.execute('insert into addresses values (?,?,?,?,?,?,?,?)',(uuid.uuid4().hex,u['id'],clean(d.get('label'),60) or 'Home',addr,city,1 if d.get('is_default') else 0,now_iso(),now_iso()))
    return me()

@app.get('/api/wishlist')
def wishlist():
    u,e=require_login()
    if e: return e
    with db() as con:
        rows=con.execute('select p.* from wishlists w join products p on p.id=w.product_id where w.user_id=? order by w.created_at desc',(u['id'],)).fetchall()
        imgs=product_images_for(con,[r['id'] for r in rows]); features=product_features_for(con,[r['id'] for r in rows])
    return jsonify({'products':[public_product(r,imgs,features) for r in rows]})
@app.post('/api/wishlist/<pid>')
def add_wishlist(pid):
    u,e=require_login()
    if e: return e
    with db() as con:
        pid=resolve_product_id(con,pid)
        if not pid or not con.execute("select id from products where id=? and status='active'",(pid,)).fetchone(): return jsonify({'error':'Product not found.'}),404
        if DATABASE_URL: con.execute('insert into wishlists values (?,?,?) on conflict(user_id,product_id) do nothing',(u['id'],pid,now_iso()))
        else: con.execute('insert or ignore into wishlists values (?,?,?)',(u['id'],pid,now_iso()))
    return jsonify({'ok':True})
@app.delete('/api/wishlist/<pid>')
def remove_wishlist(pid):
    u,e=require_login()
    if e: return e
    with db() as con: con.execute('delete from wishlists where user_id=? and product_id=?',(u['id'],pid))
    return jsonify({'ok':True})

def groq_chat(messages):
    """Make one bounded Groq Chat Completions call without leaking credentials."""
    payload = json.dumps({
        'model': GROQ_MODEL,
        'messages': messages,
        'temperature': 0.3,
        # Groq's current Chat Completions API uses max_completion_tokens.
        'max_completion_tokens': 220,
    }).encode('utf-8')
    req = Request(
        GROQ_API_URL,
        data=payload,
        headers={
            'Authorization': f'Bearer {GROQ_API_KEY}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        method='POST',
    )
    with urlopen(req, timeout=AI_REQUEST_TIMEOUT_SECONDS) as response:
        result = json.loads(response.read().decode('utf-8'))
    choices = result.get('choices') if isinstance(result, dict) else None
    content = choices[0].get('message', {}).get('content') if isinstance(choices, list) and choices else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError('provider returned no assistant message')
    return clean(content, 1200)


@app.post('/api/assistant')
def shopping_assistant():
    data=request.get_json(silent=True) or {}
    question=clean(data.get('question'),500)
    if not question: return jsonify({'error':'Ask a product question first.'}),400
    history=data.get('history') if isinstance(data.get('history'),list) else []
    history=[{'role':'assistant' if row.get('role')=='assistant' else 'user','content':clean(row.get('content'),600)} for row in history[-8:] if isinstance(row,dict) and clean(row.get('content'),600)]
    terms=[t for t in re.findall(r'[a-z0-9]{3,}',question.lower()) if t not in {'please','need','want','under','with','from','mujhe','chahiye','karo'}]
    with db() as con:
        rows=con.execute("select * from products where status='active' and stock>0 order by (price-discount) asc limit 100").fetchall()
        imgs=product_images_for(con,[r['id'] for r in rows]); features=product_features_for(con,[r['id'] for r in rows])
    scored=sorted(rows,key=lambda r:sum(t in (' '.join([r['name'],r['category'],r['brand'],r['description'] or '']).lower()) for t in terms),reverse=True)[:4]
    products=[public_product(r,imgs,features) for r in scored]
    answer='Here are the closest available products from Friends Traders. Please confirm features and stock with us before ordering.'
    provider_used=False
    if AI_ASSISTANT_ENABLED and GROQ_API_KEY:
        try:
            catalog='\n'.join(f"- {p['name']} | {p['category']} | PKR {p['final_price']} | stock {p['stock']}" for p in products)
            prompt=("You are Friends Traders Multan shopping assistant. Reply in short helpful Urdu/Roman Urdu or English matching the customer. "
                    "Only recommend available catalog products and never invent prices or stock. Delivery is free, home delivery is only for Multan areas, and customers receive an update after confirmation. "
                    "Payment methods are COD, JazzCash, and Easypaisa; payment number is 03007195451. If catalog is not enough, ask customer to contact WhatsApp 03007195451.\nCatalog:\n"+catalog+"\nCustomer: "+question)
            answer=groq_chat([{'role':'system','content':'You are a precise local-store assistant.'},*history,{'role':'user','content':prompt}]) or answer
            provider_used=True
        except HTTPError as exc:
            # Do not log a provider body: it could echo sensitive request data.
            app.logger.warning('AI assistant provider rejected request (HTTP %s); using catalog fallback', exc.code)
        except URLError as exc:
            app.logger.warning('AI assistant provider connection failed (%s); using catalog fallback', getattr(exc, 'reason', 'network error'))
        except (TimeoutError, ValueError, json.JSONDecodeError) as exc:
            app.logger.warning('AI assistant provider returned an unusable response (%s); using catalog fallback', type(exc).__name__)
        except Exception:
            app.logger.exception('AI assistant provider failed unexpectedly; using catalog fallback')
    return jsonify({'answer':answer,'products':products,'assistant_mode':'ai' if provider_used else 'catalog'})

@app.get('/api/reviews')
def list_reviews():
    with db() as con:
        rows=[dict(r) for r in con.execute('select id,name,phone,rating,message,created_at from reviews where active=1 order by created_at desc limit 30')]
    return jsonify({'reviews':rows})

@app.post('/api/reviews')
def add_review():
    d=request.get_json(silent=True) or {}
    name=clean(d.get('name'),120); phone=clean(d.get('phone'),60); message=clean(d.get('message'),1000)
    try: rating=max(1,min(5,int(d.get('rating') or 5)))
    except Exception: rating=5
    if not name or not message: return jsonify({'error':'Name and review message are required.'}),400
    rid=uuid.uuid4().hex
    with db() as con:
        con.execute('insert into reviews values (?,?,?,?,?,?,?)',(rid,name,phone,rating,message,1,now_iso()))
    return jsonify({'review':{'id':rid,'name':name,'phone':phone,'rating':rating,'message':message,'created_at':now_iso()}})

@app.get('/api/products')
def list_products():
    u=current_user(); q=clean(request.args.get('q'),120).lower(); cat=clean(request.args.get('category'),80); brand=clean(request.args.get('brand'),80); status=clean(request.args.get('status'),30); sort=request.args.get('sort','newest'); page=max(1,int(request.args.get('page',1))); per=min(48,max(1,int(request.args.get('per_page',12))))
    if u and u['role']=='owner':
        per=min(500,max(1,int(request.args.get('per_page',48))))
    where=[]; params=[]
    if not u or u['role']!='owner': where.append("status='active'")
    elif status: where.append('status=?'); params.append(status)
    if q: where.append('(lower(name) like ? or lower(sku) like ? or lower(description) like ?)'); params += [f'%{q}%']*3
    if cat: where.append('category_slug=?'); params.append(cat)
    if brand: where.append('brand=?'); params.append(brand)
    if request.args.get('min_price'): where.append('(price-discount)>=?'); params.append(money(request.args.get('min_price')))
    if request.args.get('max_price'): where.append('(price-discount)<=?'); params.append(money(request.args.get('max_price')))
    order={'price_asc':'(price-discount) asc','price_desc':'(price-discount) desc','name':'name asc','stock':'stock asc'}.get(sort,'created_at desc')
    clause=' where '+' and '.join(where) if where else ''
    with db() as con:
        total=con.execute(f'select count(*) c from products{clause}',params).fetchone()['c']
        rows=con.execute(f'select * from products{clause} order by {order} limit ? offset ?',[*params,per,(page-1)*per]).fetchall()
        image_map=product_images_for(con, [r['id'] for r in rows])
        feature_map=product_features_for(con, [r['id'] for r in rows])
        facets={'categories':[dict(r) for r in con.execute("select category_slug slug,category name,count(*) count from products where status='active' group by category_slug,category order by category")], 'brands':[r['brand'] for r in con.execute("select distinct brand from products where status='active' order by brand")]}
    return jsonify({'products':[public_product(r, image_map, feature_map) for r in rows],'total':total,'page':page,'per_page':per,'facets':facets})
@app.get('/api/products/<pid>')
def product_detail(pid):
    with db() as con:
        r=con.execute('select * from products where id=?',(pid,)).fetchone()
        image_map=product_images_for(con, [r['id']]) if r else {}
        feature_map=product_features_for(con, [r['id']]) if r else {}
    return (jsonify({'product':public_product(r, image_map, feature_map)}) if r else (jsonify({'error':'Product not found.'}),404))

def payload():
    s=request.form if request.form else (request.get_json(silent=True) or {})
    for f in ['sku','name','category','brand','price']:
        if not clean(s.get(f),300): raise ValueError(f'{f} is required.')
    cat=clean(s.get('category'),120); slug=clean(s.get('category_slug'),120).lower().replace(' ','-') or cat.lower().replace(' ','-')
    return {'sku':clean(s.get('sku'),80),'name':clean(s.get('name'),180),'category':cat,'category_slug':slug,'brand':clean(s.get('brand'),120),'description':clean(s.get('description'),3000),'price':money(s.get('price')),'discount':money(s.get('discount')),'stock':max(0,int(float(s.get('stock') or 0))),'status':clean(s.get('status'),20) or 'active'}
def save_images(files,pid,name):
    saved=[]
    for n,f in enumerate(files,1):
        if not f or not f.filename: continue
        ext=Path(f.filename).suffix.lower()
        if ext not in ALLOWED_IMAGE_EXTS: continue
        if DATABASE_URL:
            raw = f.read()
            if len(raw) > int(os.getenv('MAX_DB_IMAGE_BYTES', str(1024*1024))):
                continue
            mime = 'image/webp' if ext == '.webp' else ('image/png' if ext == '.png' else 'image/jpeg')
            saved.append(('data:' + mime + ';base64,' + base64.b64encode(raw).decode('ascii'), n))
            continue
        fn=f'{pid}-{uuid.uuid4().hex[:10]}-{secure_filename(Path(f.filename).stem)[:50] or "product"}.webp'; target=UPLOAD_DIR/fn
        if Image:
            img=Image.open(f.stream).convert('RGB'); img.thumbnail((1400,1400)); img.save(target,'WEBP',quality=82,method=6)
        else: f.save(target)
        saved.append(('/uploads/'+fn,n))
    return saved
@app.post('/api/products')
def create_product():
    u,e=require_owner();
    if e: return e
    try: d=payload()
    except ValueError as ex: return jsonify({'error':str(ex)}),400
    try:
        with db() as con:
            # A repeated Save click should update the same named product in the
            # selected category instead of creating a second card and cart item.
            existing=con.execute("select id from products where lower(trim(name))=lower(trim(?)) and category_slug=? order by updated_at desc limit 1",(d['name'],d['category_slug'])).fetchone()
            pid=existing['id'] if existing else uuid.uuid4().hex
            if existing:
                con.execute('update products set sku=?,name=?,category=?,category_slug=?,brand=?,description=?,price=?,discount=?,stock=?,status=?,updated_at=? where id=?',(d['sku'],d['name'],d['category'],d['category_slug'],d['brand'],d['description'],d['price'],d['discount'],d['stock'],d['status'],now_iso(),pid))
            else:
                con.execute('insert into products values (?,?,?,?,?,?,?,?,?,?,?,?,?)',(pid,d['sku'],d['name'],d['category'],d['category_slug'],d['brand'],d['description'],d['price'],d['discount'],d['stock'],d['status'],now_iso(),now_iso()))
            image_url = clean((request.form if request.form else {}).get('image_url'), 1000)
            if image_url: con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,image_url,d['name'],0,now_iso()))
            save_features(con, pid, (request.form if request.form else {}).get('features'))
            for url,order in save_images(request.files.getlist('images'),pid,d['name']): con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,url,d['name'],order,now_iso()))
    except Exception: return jsonify({'error':'SKU already exists.'}),409
    return product_detail(pid)
@app.put('/api/products/<pid>')
def update_product(pid):
    u,e=require_owner();
    if e: return e
    try: d=payload()
    except ValueError as ex: return jsonify({'error':str(ex)}),400
    try:
        with db() as con:
            pid = resolve_product_id(con, pid) or pid
            if not con.execute('select id from products where id=?',(pid,)).fetchone(): return jsonify({'error':'Product not found.'}),404
            con.execute('update products set sku=?,name=?,category=?,category_slug=?,brand=?,description=?,price=?,discount=?,stock=?,status=?,updated_at=? where id=?',(d['sku'],d['name'],d['category'],d['category_slug'],d['brand'],d['description'],d['price'],d['discount'],d['stock'],d['status'],now_iso(),pid))
            image_url = clean((request.form if request.form else {}).get('image_url'), 1000)
            if image_url: con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,image_url,d['name'],0,now_iso()))
            save_features(con, pid, (request.form if request.form else {}).get('features'))
            for url,order in save_images(request.files.getlist('images'),pid,d['name']): con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,url,d['name'],order,now_iso()))
    except Exception: return jsonify({'error':'SKU already exists.'}),409
    return product_detail(pid)
@app.patch('/api/products/<pid>')
def patch_product(pid):
    u,e=require_owner();
    if e: return e
    d=request.get_json(silent=True) or {}; sets=[]; params=[]
    if 'status' in d: sets.append('status=?'); params.append(clean(d['status'],20))
    if 'stock' in d: sets.append('stock=?'); params.append(max(0,int(d['stock'])))
    if not sets: return jsonify({'error':'No supported fields supplied.'}),400
    with db() as con:
        pid = resolve_product_id(con, pid) or pid
        con.execute(f"update products set {','.join(sets)},updated_at=? where id=?",[*params,now_iso(),pid])
    return product_detail(pid)
@app.delete('/api/products/<pid>')
def delete_product(pid):
    u,e=require_owner();
    if e: return e
    with db() as con:
        pid = resolve_product_id(con, pid) or pid
        imgs=con.execute('select url from product_images where product_id=?',(pid,)).fetchall(); con.execute('delete from products where id=?',(pid,))
    for img in imgs:
        if img['url'].startswith('/uploads/'):
            p=UPLOAD_DIR/img['url'].split('/uploads/',1)[1]
            if p.exists(): p.unlink()
    return jsonify({'ok':True})

def cart_key():
    u=current_user(); return 'user:'+u['id'] if u else session['guest_key']
def cart_payload():
    key=cart_key()
    with db() as con: rows=con.execute('''select ci.product_id,ci.quantity,p.name,p.price,p.discount,p.stock,p.status,(select url from product_images where product_id=p.id order by sort_order,id limit 1) image from cart_items ci join products p on p.id=ci.product_id where ci.cart_key=?''',(key,)).fetchall()
    items=[]; subtotal=0
    for r in rows:
        price=max(0,float(r['price'])-float(r['discount'])); qty=min(int(r['quantity']),int(r['stock'])) if r['status']=='active' else 0; subtotal += price*qty
        d=dict(r); d.update({'quantity':qty,'unit_price':price,'line_total':round(price*qty,2)}); items.append(d)
    shipping=0
    return {'items':items,'subtotal':round(subtotal,2),'shipping':shipping,'total':round(subtotal+shipping,2)}
@app.get('/api/cart')
def get_cart(): return jsonify(cart_payload())
@app.post('/api/cart/items')
def add_cart():
    d=request.get_json(silent=True) or {}; pid=clean(d.get('product_id'),80); qty=max(1,int(d.get('quantity') or 1))
    key = cart_key()
    with db() as con:
        pid = resolve_product_id(con, pid)
        p=con.execute('select stock,status from products where id=?',(pid,)).fetchone() if pid else None
        if not p or p['status']!='active' or p['stock']<=0: return jsonify({'error':'Product is not available.'}),400
        existing=con.execute('select quantity from cart_items where cart_key=? and product_id=?',(key,pid)).fetchone()
        next_qty=min(int(p['stock']), (int(existing['quantity']) if existing else 0) + qty)
        if existing:
            con.execute('update cart_items set quantity=?,updated_at=? where cart_key=? and product_id=?',(next_qty,now_iso(),key,pid))
        else:
            con.execute('insert into cart_items values (?,?,?,?)',(key,pid,next_qty,now_iso()))
    return jsonify(cart_payload())
@app.patch('/api/cart/items/<pid>')
def update_cart(pid):
    d=request.get_json(silent=True) or {}; qty=max(0,int(d.get('quantity') or 0))
    with db() as con:
        if qty:
            s=con.execute('select stock from products where id=?',(pid,)).fetchone(); con.execute('update cart_items set quantity=?,updated_at=? where cart_key=? and product_id=?',(min(qty,s['stock'] if s else qty),now_iso(),cart_key(),pid))
        else: con.execute('delete from cart_items where cart_key=? and product_id=?',(cart_key(),pid))
    return jsonify(cart_payload())

def order_payload(oid):
    with db() as con:
        o=one(con.execute('select * from orders where id=?',(oid,)).fetchone())
        if not o: return None
        o['items']=[dict(r) for r in con.execute('select * from order_items where order_id=?',(oid,))]
    return o


def order_payloads(con, ids):
    if not ids:
        return []
    placeholders = ','.join('?' for _ in ids)
    orders = [dict(r) for r in con.execute(f'select * from orders where id in ({placeholders})', ids).fetchall()]
    order_map = {o['id']: o for o in orders}
    for o in orders:
        o['items'] = []
    for item in con.execute(f'select * from order_items where order_id in ({placeholders}) order by order_id', ids).fetchall():
        order_map[item['order_id']]['items'].append(dict(item))
    return [order_map[i] for i in ids if i in order_map]
@app.post('/api/checkout')
def checkout():
    d=request.get_json(silent=True) or {}; u=current_user(); c=d.get('customer') or {}; name=clean(c.get('name') or (u or {}).get('name'),140); phone=clean(c.get('phone') or (u or {}).get('phone'),60); email=clean(c.get('email') or (u or {}).get('email'),180); addr=clean(c.get('address'),1200)
    if not name or not phone or not addr: return jsonify({'error':'Name, phone, and complete address are required.'}),400
    if 'multan' not in addr.lower():
        return jsonify({'error':'Delivery is currently available only in Multan. Please include Multan in your address.'}),400
    method=clean(d.get('payment_method'),40) or 'cod'; coupon_code=clean(d.get('coupon_code'),40).upper()
    with db() as con:
        rows=con.execute('select ci.product_id,ci.quantity,p.sku,p.name,p.price,p.discount,p.stock,p.status from cart_items ci join products p on p.id=ci.product_id where ci.cart_key=?',(cart_key(),)).fetchall()
        if not rows: return jsonify({'error':'Cart is empty.'}),400
        subtotal=0; lines=[]
        for r in rows:
            if r['status']!='active' or r['stock']<r['quantity']: return jsonify({'error':f"Insufficient stock for {r['name']}."}),409
            unit=max(0,float(r['price'])-float(r['discount'])); subtotal += unit*int(r['quantity']); lines.append((r,unit))
        coupon=con.execute('select * from coupons where code=? and active=1',(coupon_code,)).fetchone() if coupon_code else None; disc=0
        if coupon and subtotal >= float(coupon['min_total']): disc = subtotal*float(coupon['value'])/100 if coupon['kind']=='percent' else float(coupon['value'])
        ship=0; total=round(max(0,subtotal-disc)+ship,2); oid='FT-'+datetime.now().strftime('%y%m%d')+'-'+secrets.token_hex(3).upper()
        con.execute('insert into orders values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(oid,(u or {}).get('id'),name,phone,email,addr,method,'pending' if method!='cod' else 'cod','pending',round(subtotal,2),round(disc,2),ship,total,coupon_code,now_iso(),now_iso()))
        for r,unit in lines:
            con.execute('insert into order_items values (?,?,?,?,?,?,?,?)',(uuid.uuid4().hex,oid,r['product_id'],r['sku'],r['name'],r['quantity'],unit,round(unit*r['quantity'],2)))
            con.execute('update products set stock=stock-?,updated_at=? where id=?',(r['quantity'],now_iso(),r['product_id']))
        con.execute('delete from cart_items where cart_key=?',(cart_key(),))
        con.execute('insert into notifications values (?,?,?,?,?,?,null)',(uuid.uuid4().hex,'owner','new_order',f'New order {oid} received',oid,now_iso()))
        con.execute('insert into order_status_events values (?,?,?,?,?)',(uuid.uuid4().hex,oid,'pending','Order placed',now_iso()))
    order=order_payload(oid); notify_order_hook(order)
    return jsonify({'order':order})
@app.get('/api/orders')
def list_orders():
    u,e=require_login();
    if e: return e
    with db() as con:
        rows=con.execute('select id from orders order by created_at desc limit 300' if u['role']=='owner' else 'select id from orders where user_id=? order by created_at desc',( () if u['role']=='owner' else (u['id'],) )).fetchall()
        ids=[r['id'] for r in rows]
        orders=order_payloads(con, ids)
    return jsonify({'orders':orders})

@app.get('/api/owner/summary')
def owner_summary():
    u,e=require_owner();
    if e: return e
    today=date.today().isoformat(); month=today[:7]
    with db() as con:
        sc={r['order_status']:r['c'] for r in con.execute('select order_status,count(*) c from orders group by order_status')}
        cards={'total_products':con.execute('select count(*) c from products').fetchone()['c'],'total_orders':con.execute('select count(*) c from orders').fetchone()['c'],'pending_orders':sc.get('pending',0),'processing_orders':sc.get('processing',0),'completed_orders':sc.get('completed',0),'cancelled_orders':sc.get('cancelled',0),'revenue':round(float(con.execute("select coalesce(sum(total),0) v from orders where order_status='completed'").fetchone()['v']),2),'today_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,10)=?',(today,)).fetchone()['v']),2),'monthly_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,7)=?',(month,)).fetchone()['v']),2)}
        order_ids=con.execute('select id from orders order by created_at desc limit 300').fetchall()
        ids=[r['id'] for r in order_ids]
        orders=order_payloads(con, ids)
        product_rows=con.execute('select * from products order by updated_at desc limit 500').fetchall()
        product_ids=[r['id'] for r in product_rows]
        image_map=product_images_for(con, product_ids)
        feature_map=product_features_for(con, product_ids)
        products=[public_product(r, image_map, feature_map) for r in product_rows]
        low=[p for p in products if p['stock'] <= LOW_STOCK_THRESHOLD][:30]
        notes=[dict(r) for r in con.execute("select * from notifications where audience in ('owner','all') and read_at is null order by created_at desc limit 30")]
    return jsonify({'cards':cards,'orders':orders,'products':products,'low_stock':low,'notifications':notes})

@app.patch('/api/orders/<oid>')
def update_order(oid):
    u,e=require_owner();
    if e: return e
    d=request.get_json(silent=True) or {}; status=clean(d.get('order_status'),30); payment=clean(d.get('payment_status'),30)
    if status and status not in {'pending','processing','completed','cancelled'}: return jsonify({'error':'Invalid order status.'}),400
    with db() as con:
        old=con.execute('select order_status from orders where id=?',(oid,)).fetchone()
        if not old: return jsonify({'error':'Order not found.'}),404
        if status == 'cancelled' and old['order_status'] != 'cancelled':
            for item in con.execute('select product_id,quantity from order_items where order_id=?',(oid,)): con.execute('update products set stock=stock+?,updated_at=? where id=?',(item['quantity'],now_iso(),item['product_id']))
            con.execute('insert into notifications values (?,?,?,?,?,?,null)',(uuid.uuid4().hex,'customer','order_cancelled',f'Order {oid} was cancelled',oid,now_iso()))
        if status and old['order_status']=='cancelled' and status!='cancelled': return jsonify({'error':'Cancelled orders cannot be reopened.'}),409
        sets=[]; params=[]
        if status: sets.append('order_status=?'); params.append(status)
        if payment: sets.append('payment_status=?'); params.append(payment)
        if sets:
            con.execute(f"update orders set {','.join(sets)},updated_at=? where id=?",[*params,now_iso(),oid])
            con.execute('insert into notifications values (?,?,?,?,?,?,null)',(uuid.uuid4().hex,'customer','order_status',f"Order {oid} is now {status or 'updated'}",oid,now_iso()))
            if status: con.execute('insert into order_status_events values (?,?,?,?,?)',(uuid.uuid4().hex,oid,status,clean(d.get('note'),500),now_iso()))
    return jsonify({'order':order_payload(oid)})

def make_pdf(text):
    safe=text.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
    stream='BT /F1 12 Tf 50 780 Td 14 TL ' + ' T* '.join(f'({line}) Tj' for line in safe.splitlines()) + ' ET'
    objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream']
    pdf='%PDF-1.4\n'; offs=[]
    for i,o in enumerate(objs,1): offs.append(len(pdf)); pdf += f'{i} 0 obj\n{o}\nendobj\n'
    x=len(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + ''.join(f'{o:010d} 00000 n \n' for o in offs) + f'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n{x}\n%%EOF'
    return pdf.encode('latin-1','replace')
@app.get('/api/orders/<oid>/invoice')
def invoice(oid):
    o=order_payload(oid)
    if not o: return jsonify({'error':'Order not found.'}),404
    lines=['FRIENDS TRADERS INVOICE',oid,o['customer_name'],o['phone'],o['address'],'']+[f"{i['name']} x {i['quantity']} = PKR {i['line_total']}" for i in o['items']]+['',f"Total: PKR {o['total']}",f"Status: {o['order_status']}"]
    return Response(make_pdf('\n'.join(lines)),mimetype='application/pdf',headers={'Content-Disposition':f'inline; filename=invoice-{oid}.pdf'})
@app.get('/api/dashboard')
def dashboard():
    u,e=require_owner();
    if e: return e
    today=date.today().isoformat(); month=today[:7]
    with db() as con:
        sc={r['order_status']:r['c'] for r in con.execute('select order_status,count(*) c from orders group by order_status')}
        cards={'total_products':con.execute('select count(*) c from products').fetchone()['c'],'total_orders':con.execute('select count(*) c from orders').fetchone()['c'],'pending_orders':sc.get('pending',0),'processing_orders':sc.get('processing',0),'completed_orders':sc.get('completed',0),'cancelled_orders':sc.get('cancelled',0),'revenue':round(float(con.execute("select coalesce(sum(total),0) v from orders where order_status='completed'").fetchone()['v']),2),'today_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,10)=?',(today,)).fetchone()['v']),2),'monthly_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,7)=?',(month,)).fetchone()['v']),2)}
        best=[dict(r) for r in con.execute('select name,sum(quantity) quantity,sum(line_total) total from order_items group by product_id,name order by quantity desc limit 8')]
        recent=[order_payload(r['id']) for r in con.execute('select id from orders order by created_at desc limit 10')]
        low_rows=con.execute('select * from products where stock<=? order by stock asc limit 12',(LOW_STOCK_THRESHOLD,)).fetchall()
        low_images=product_images_for(con, [r['id'] for r in low_rows])
        low=[public_product(r, low_images) for r in low_rows]
        monthly=[dict(r) for r in con.execute('select substr(created_at,1,7) month,count(*) orders,coalesce(sum(total),0) revenue from orders group by substr(created_at,1,7) order by month limit 12')]
        growth=[dict(r) for r in con.execute("select substr(created_at,1,7) month,count(*) customers from users where role='customer' group by substr(created_at,1,7) order by month limit 12")]
        notes=[dict(r) for r in con.execute("select * from notifications where audience in ('owner','all') and read_at is null order by created_at desc limit 20")]
    return jsonify({'cards':cards,'best_selling':best,'recent_orders':recent,'low_stock':low,'monthly':monthly,'customer_growth':growth,'notifications':notes})
@app.get('/api/export/<kind>.<fmt>')
def export(kind,fmt):
    u,e=require_owner();
    if e: return e
    if kind not in {'products','orders'} or fmt not in {'csv','xls','pdf'}: return jsonify({'error':'Unsupported export.'}),400
    with db() as con: rows=[dict(r) for r in con.execute('select * from products' if kind=='products' else 'select * from orders order by created_at desc')]
    if fmt=='pdf': return Response(make_pdf('\n'.join([kind.upper(),*[json.dumps(r,ensure_ascii=False) for r in rows[:80]]])),mimetype='application/pdf',headers={'Content-Disposition':f'attachment; filename={kind}.pdf'})
    out=io.StringIO(); writer=csv.DictWriter(out,fieldnames=list(rows[0].keys()) if rows else ['empty']); writer.writeheader(); writer.writerows(rows)
    return Response(out.getvalue(),mimetype='text/csv' if fmt=='csv' else 'application/vnd.ms-excel',headers={'Content-Disposition':f'attachment; filename={kind}.{fmt}'})
@app.post('/api/backup')
def backup():
    u,e=require_owner();
    if e: return e
    tables=['users','addresses','products','product_images','coupons','orders','order_items','cart_items','notifications']; data={}
    with db() as con:
        for t in tables: data[t]=[dict(r) for r in con.execute(f'select * from {t}')]
    target=BACKUP_DIR/f"backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"; target.write_text(json.dumps(data,indent=2),encoding='utf-8')
    return jsonify({'ok':True,'path':str(target),'backup':data})
@app.post('/api/restore')
def restore():
    u,e=require_owner();
    if e: return e
    data=request.get_json(silent=True) or {}; allowed={'products','product_images','coupons','orders','order_items','addresses','notifications'}
    with db() as con:
        for table,rows in data.items():
            if table not in allowed or not isinstance(rows,list): continue
            for row in rows:
                cols=list(row.keys());
                if DATABASE_URL:
                    con.execute(f"insert into {table} ({','.join(cols)}) values ({','.join('%s' for _ in cols)}) on conflict do nothing", [row[c] for c in cols])
                else:
                    con.execute(f"insert or replace into {table} ({','.join(cols)}) values ({','.join('?' for _ in cols)})",[row[c] for c in cols])
    return jsonify({'ok':True})
if __name__ == '__main__': app.run(host='127.0.0.1',port=int(os.getenv('PORT','5001')),debug=os.getenv('FLASK_DEBUG')=='true')


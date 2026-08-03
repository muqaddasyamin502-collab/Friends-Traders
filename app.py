import base64, csv, io, json, os, re, secrets, sqlite3, uuid
from datetime import datetime, timezone, date
from pathlib import Path
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
OWNER_PASSWORD = os.getenv('OWNER_PASSWORD', 'Friends@1122Local')
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
            if owner['email'] != OWNER_EMAIL or not check_password_hash(owner['password_hash'], OWNER_PASSWORD):
                con.execute('update users set email=?,password_hash=?,updated_at=? where id=?', (OWNER_EMAIL, generate_password_hash(OWNER_PASSWORD), now_iso(), owner['id']))
        else:
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

def images(pid):
    with db() as con:
        return product_images_for(con, [pid]).get(pid, [])

def public_product(r, image_map=None):
    d = dict(r); d['price']=float(d['price']); d['discount']=float(d['discount']); d['final_price']=max(0, round(d['price']-d['discount'],2)); d['low_stock']=d['stock']<=LOW_STOCK_THRESHOLD; d['out_of_stock']=d['stock']<=0; d['images']=(image_map or {}).get(d['id']) if image_map is not None else images(d['id']); return d

migrate(); seed()

@app.get('/')
def home(): return send_from_directory(BASE_DIR, 'index.html')
@app.get('/uploads/<path:p>')
def uploaded(p): return send_from_directory(UPLOAD_DIR, p)
@app.get('/api/health')
def health():
    with db() as con:
        return jsonify({'ok':True,'database':('supabase' if DATABASE_URL else str(DB_PATH)),'products':con.execute('select count(*) c from products').fetchone()['c'],'orders':con.execute('select count(*) c from orders').fetchone()['c'],'storage':('supabase-postgres' if DATABASE_URL else 'sqlite-local; Supabase SQL schema included')})
@app.get('/api/csrf')
def csrf(): session['csrf_token']=secrets.token_urlsafe(32); return jsonify({'csrf_token':session['csrf_token'],'user':current_user()})

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
    with db() as con: u=con.execute('select * from users where email=?',(email,)).fetchone()
    if not u or not check_password_hash(u['password_hash'], pw): return jsonify({'error':'Invalid email or password.'}),401
    session['user_id']=u['id']; return jsonify({'user':current_user()})
@app.post('/api/auth/owner-login')
def owner_login():
    data=request.get_json(silent=True) or {}; pw=str(data.get('password') or '')
    with db() as con: u=con.execute("select * from users where role='owner' order by created_at limit 1").fetchone()
    if not u or not check_password_hash(u['password_hash'], pw): return jsonify({'error':'Invalid owner password.'}),401
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
        facets={'categories':[dict(r) for r in con.execute("select category_slug slug,category name,count(*) count from products where status='active' group by category_slug,category order by category")], 'brands':[r['brand'] for r in con.execute("select distinct brand from products where status='active' order by brand")]}
    return jsonify({'products':[public_product(r, image_map) for r in rows],'total':total,'page':page,'per_page':per,'facets':facets})
@app.get('/api/products/<pid>')
def product_detail(pid):
    with db() as con:
        r=con.execute('select * from products where id=?',(pid,)).fetchone()
        image_map=product_images_for(con, [r['id']]) if r else {}
    return (jsonify({'product':public_product(r, image_map)}) if r else (jsonify({'error':'Product not found.'}),404))

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
    pid=uuid.uuid4().hex
    try:
        with db() as con:
            con.execute('insert into products values (?,?,?,?,?,?,?,?,?,?,?,?,?)',(pid,d['sku'],d['name'],d['category'],d['category_slug'],d['brand'],d['description'],d['price'],d['discount'],d['stock'],d['status'],now_iso(),now_iso()))
            image_url = clean((request.form if request.form else {}).get('image_url'), 1000)
            if image_url: con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,image_url,d['name'],0,now_iso()))
            for url,order in save_images(request.files.getlist('images'),pid,d['name']): con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,url,d['name'],order,now_iso()))
        return product_detail(pid)
    except Exception: return jsonify({'error':'SKU already exists.'}),409
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
            for url,order in save_images(request.files.getlist('images'),pid,d['name']): con.execute('insert into product_images values (?,?,?,?,?,?)',(uuid.uuid4().hex,pid,url,d['name'],order,now_iso()))
        return product_detail(pid)
    except Exception: return jsonify({'error':'SKU already exists.'}),409
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
    shipping=0 if subtotal>=10000 or subtotal==0 else 300
    return {'items':items,'subtotal':round(subtotal,2),'shipping':shipping,'total':round(subtotal+shipping,2)}
@app.get('/api/cart')
def get_cart(): return jsonify(cart_payload())
@app.post('/api/cart/items')
def add_cart():
    d=request.get_json(silent=True) or {}; pid=clean(d.get('product_id'),80); qty=max(1,int(d.get('quantity') or 1))
    with db() as con:
        pid = resolve_product_id(con, pid)
        p=con.execute('select stock,status from products where id=?',(pid,)).fetchone() if pid else None
        if not p or p['status']!='active' or p['stock']<=0: return jsonify({'error':'Product is not available.'}),400
        con.execute('insert into cart_items values (?,?,?,?) on conflict(cart_key,product_id) do update set quantity=case when quantity+excluded.quantity < ? then quantity+excluded.quantity else ? end,updated_at=excluded.updated_at',(cart_key(),pid,min(qty,p['stock']),now_iso(),p['stock'],p['stock']))
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
        ship=0 if subtotal>=10000 else 300; total=round(max(0,subtotal-disc)+ship,2); oid='FT-'+datetime.now().strftime('%y%m%d')+'-'+secrets.token_hex(3).upper()
        con.execute('insert into orders values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(oid,(u or {}).get('id'),name,phone,email,addr,method,'pending' if method!='cod' else 'cod','pending',round(subtotal,2),round(disc,2),ship,total,coupon_code,now_iso(),now_iso()))
        for r,unit in lines:
            con.execute('insert into order_items values (?,?,?,?,?,?,?,?)',(uuid.uuid4().hex,oid,r['product_id'],r['sku'],r['name'],r['quantity'],unit,round(unit*r['quantity'],2)))
            con.execute('update products set stock=stock-?,updated_at=? where id=?',(r['quantity'],now_iso(),r['product_id']))
        con.execute('delete from cart_items where cart_key=?',(cart_key(),))
        con.execute('insert into notifications values (?,?,?,?,?,?,null)',(uuid.uuid4().hex,'owner','new_order',f'New order {oid} received',oid,now_iso()))
    return jsonify({'order':order_payload(oid)})
@app.get('/api/orders')
def list_orders():
    u,e=require_login();
    if e: return e
    with db() as con:
        rows=con.execute('select id from orders order by created_at desc limit 300' if u['role']=='owner' else 'select id from orders where user_id=? order by created_at desc',( () if u['role']=='owner' else (u['id'],) )).fetchall()
    return jsonify({'orders':[order_payload(r['id']) for r in rows]})


@app.get('/api/owner/summary')
def owner_summary():
    u,e=require_owner();
    if e: return e
    today=date.today().isoformat(); month=today[:7]
    with db() as con:
        sc={r['order_status']:r['c'] for r in con.execute('select order_status,count(*) c from orders group by order_status')}
        cards={'total_products':con.execute('select count(*) c from products').fetchone()['c'],'total_orders':con.execute('select count(*) c from orders').fetchone()['c'],'pending_orders':sc.get('pending',0),'processing_orders':sc.get('processing',0),'completed_orders':sc.get('completed',0),'cancelled_orders':sc.get('cancelled',0),'revenue':round(float(con.execute("select coalesce(sum(total),0) v from orders where order_status='completed'").fetchone()['v']),2),'today_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,10)=?',(today,)).fetchone()['v']),2),'monthly_sales':round(float(con.execute('select coalesce(sum(total),0) v from orders where substr(created_at,1,7)=?',(month,)).fetchone()['v']),2)}
        order_ids=con.execute('select id from orders order by created_at desc limit 300').fetchall()
        product_rows=con.execute('select * from products order by updated_at desc limit 500').fetchall()
        image_map=product_images_for(con, [r['id'] for r in product_rows])
        products=[public_product(r, image_map) for r in product_rows]
        low=[p for p in products if p['stock'] <= LOW_STOCK_THRESHOLD][:30]
        notes=[dict(r) for r in con.execute("select * from notifications where audience in ('owner','all') and read_at is null order by created_at desc limit 30")]
    return jsonify({'cards':cards,'orders':[order_payload(r['id']) for r in order_ids],'products':products,'low_stock':low,'notifications':notes})

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


import os, sqlite3, uuid, time, base64, io, jwt, bcrypt
from datetime import datetime, timezone, timedelta
from contextlib import closing
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request, Response, File, Form, UploadFile, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from PIL import Image, ImageOps
from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

HERE = Path(__file__).resolve().parent
DB_PATH = os.getenv("DB_PATH", str(HERE / "sorumatik.db"))
API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
SECRET_KEY = os.getenv("JWT_SECRET", "gizli-anahtar-degistir-bunu")
ALGORITHM = "HS256"
DAILY_FREE = 3
PLAN_DAYS = {"weekly": 7, "monthly": 30, "yearly": 365}

STATIC_DIR = HERE.parent / "static"

app = FastAPI(title="YKS Sorumatik")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

client = genai.Client(api_key=API_KEY) if API_KEY else None

# --- Veritabanı ---
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with closing(db()) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users(
                uid TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                password_hash TEXT,
                premium_until INTEGER DEFAULT 0,
                plan TEXT DEFAULT '',
                used_date TEXT DEFAULT '',
                used_count INTEGER DEFAULT 0,
                created_at TEXT,
                role TEXT DEFAULT 'user'
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS questions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT,
                subject TEXT,
                image TEXT,
                answer TEXT,
                created_at TEXT
            );
        """)
        conn.commit()

init_db()

# --- Yardımcılar ---
def today():
    return datetime.now(timezone(timedelta(hours=3))).date().isoformat()

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())

def create_token(uid: str, email: str, role: str):
    payload = {"uid": uid, "email": email, "role": role, "exp": datetime.now(timezone.utc) + timedelta(days=7)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def get_user(request: Request, response: Response):
    # 1) JWT ile giriş yapılmış mı?
    auth = request.headers.get("Authorization")
    if auth and auth.startswith("Bearer "):
        token = auth.split(" ")[1]
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            uid = payload.get("uid")
            if uid:
                with closing(db()) as conn:
                    user = conn.execute("SELECT * FROM users WHERE uid=?", (uid,)).fetchone()
                    if user:
                        return user
        except Exception:
            pass

    # 2) Çerez (anonim kullanıcı)
    uid = request.cookies.get("uid", "")
    is_new = False
    if not uid or len(uid) > 64:
        uid = uuid.uuid4().hex
        is_new = True

    with closing(db()) as conn:
        user = conn.execute("SELECT * FROM users WHERE uid=?", (uid,)).fetchone()
        if not user:
            conn.execute("INSERT INTO users(uid, created_at) VALUES(?, ?)", (uid, datetime.now(timezone.utc).isoformat()))
            conn.commit()
            user = conn.execute("SELECT * FROM users WHERE uid=?", (uid,)).fetchone()

    if is_new:
        response.set_cookie("uid", uid, max_age=60*60*24*365, samesite="Lax", httponly=True)

    return user

def get_status(user):
    is_premium = (user["premium_until"] or 0) > time.time()
    used = user["used_count"] if user["used_date"] == today() else 0
    return {
        "is_premium": is_premium,
        "remaining": max(0, DAILY_FREE - used),
        "plan": user["plan"] if is_premium else "",
        "premium_until": user["premium_until"] if is_premium else 0,
        "email": user["email"] or "",
        "role": user["role"],
    }

def consume_quota(uid, user):
    used = user["used_count"] if user["used_date"] == today() else 0
    with closing(db()) as conn:
        conn.execute("UPDATE users SET used_date=?, used_count=? WHERE uid=?", (today(), used + 1, uid))
        conn.commit()

def ask_ai(system: str, contents: list, max_tokens: int = 2000) -> str:
    if not client:
        raise HTTPException(500, "Sunucuda GEMINI_API_KEY ayarlanmamış.")
    try:
        # DÜZELTME: Model adı güncellendi
        response = client.models.generate_content(
            model='gemini-2.0-flash',
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
                temperature=0.6,
            ),
            contents=contents
        )
        return response.text
    except Exception as e:
        print(f"AI Hatası: {e}")
        raise HTTPException(502, f"Yapay zeka hatası: {str(e)}")

def prepare_image(raw: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((1600, 1600))
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=85)
        return out.getvalue()
    except:
        raise HTTPException(400, "Fotoğraf okunamadı.")

# --- Modeller ---
class ChatTurn(BaseModel):
    role: str
    content: str

class AuthIn(BaseModel):
    email: str
    password: str

# --- Promptlar ---
SOLVE_SYSTEM = """Sen YKS (TYT/AYT) öğrencilerine yardım eden sabırlı bir Türk öğretmensin.
- Fotoğraftaki soruyu adım adım, sade Türkçe ile çöz. Önce sorunun ne istediğini kısaca belirt.
- Matematiksel ifadeleri LaTeX ile yaz: satır içi için $...$, ayrı satır için $$...$$.
- Sonda net bir "Cevap: ..." satırı ver ve varsa püf noktasını 1-2 cümleyle söyle."""

FOLLOW_SYSTEM = """Sen YKS öğrencilerine yardım eden sabırlı bir Türk öğretmensin. Kısa, net ve anlaşılır cevap ver.
Matematiği LaTeX ile yaz ($...$ veya $$...$$).
Bağlam:
Ders: {subject}
Öğrencinin notu: {note}
Daha önceki çözüm: {solution}"""

COACH_SYSTEM = """Sen samimi, destekleyici ve gerçekçi bir YKS sınav koçusun. Türkçe konuş.
Cevapların kısa, uygulanabilir ve somut olsun. Öğrenci profili: {profile}"""

# --- Auth Endpoint'leri ---
@app.post("/api/register")
def register(body: AuthIn, response: Response):
    email = body.email.strip().lower()
    if len(body.password) < 4:
        raise HTTPException(400, "Şifre en az 4 karakter olmalı.")
    with closing(db()) as conn:
        existing = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if existing:
            raise HTTPException(400, "Bu e-posta zaten kayıtlı.")

        uid = uuid.uuid4().hex
        role = "admin" if os.getenv("ADMIN_EMAIL", "").lower() == email else "user"
        conn.execute(
            "INSERT INTO users(uid, email, password_hash, created_at, role) VALUES(?,?,?,?,?)",
            (uid, email, hash_password(body.password), datetime.now(timezone.utc).isoformat(), role)
        )
        conn.commit()
        token = create_token(uid, email, role)
        return {"token": token, "uid": uid, "role": role}

@app.post("/api/login")
def login(body: AuthIn, response: Response):
    email = body.email.strip().lower()
    with closing(db()) as conn:
        user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not user or not user["password_hash"] or not verify_password(body.password, user["password_hash"]):
            raise HTTPException(401, "E-posta veya şifre hatalı.")
        token = create_token(user["uid"], user["email"], user["role"])
        return {"token": token, "uid": user["uid"], "role": user["role"]}

@app.get("/api/me")
def me(request: Request, response: Response):
    user = get_user(request, response)
    return get_status(user)

# --- Admin Endpoint'leri ---
@app.get("/api/admin/stats")
def admin_stats(request: Request, response: Response):
    user = get_user(request, response)
    if user["role"] != "admin":
        raise HTTPException(403, "Yetkisiz erişim.")
    now = int(time.time())
    with closing(db()) as conn:
        total = conn.execute("SELECT COUNT(*) as c FROM users WHERE email IS NOT NULL").fetchone()["c"]
        premium = conn.execute("SELECT COUNT(*) as c FROM users WHERE premium_until > ?", (now,)).fetchone()["c"]
        free = total - premium
        recent = conn.execute(
            "SELECT email, created_at, premium_until FROM users WHERE email IS NOT NULL ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    return {
        "total": total,
        "premium": premium,
        "free": free,
        "recent": [dict(r) for r in recent]
    }

# --- Uygulama Endpoint'leri ---
@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/api/status")
def api_status(request: Request, response: Response):
    user = get_user(request, response)
    return get_status(user)

@app.post("/api/subscribe")
async def api_subscribe(request: Request, response: Response):
    user = get_user(request, response)
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    plan = data.get("plan", "monthly")
    days = PLAN_DAYS.get(plan)
    if not days:
        raise HTTPException(400, "Geçersiz plan.")
    base = max(time.time(), user["premium_until"] or 0)
    with closing(db()) as conn:
        conn.execute("UPDATE users SET premium_until=?, plan=? WHERE uid=?", (int(base + days * 86400), plan, user["uid"]))
        conn.commit()
    return {"ok": True, **get_status(get_user(request, response))}

@app.post("/solve")
async def solve(request: Request, response: Response, file: UploadFile = File(...), subject: str = Form("TYT Matematik"), note: str = Form("")):
    user = get_user(request, response)
    st = get_status(user)
    if not st["is_premium"] and st["remaining"] <= 0:
        raise HTTPException(403, "Günlük soru hakkınız doldu. Sınırsız çözüm için Premium'a geçin.")

    raw = await file.read()
    if not raw: raise HTTPException(400, "Fotoğraf bulunamadı.")

    jpeg = prepare_image(raw)
    b64 = base64.b64encode(jpeg).decode()
    image_part = types.Part.from_bytes(data=jpeg, mime_type="image/jpeg")
    prompt = f"Ders: {subject}\nNot: {note}\nBu soruyu çöz."

    answer = ask_ai(SOLVE_SYSTEM, contents=[image_part, prompt])

    with closing(db()) as conn:
        conn.execute("INSERT INTO questions(uid,subject,image,answer,created_at) VALUES(?,?,?,?,?)",
                     (user["uid"], subject, b64, answer, datetime.now(timezone.utc).isoformat()))
        conn.commit()

    if not st["is_premium"]: consume_quota(user["uid"], user)
    return {"answer": answer, **get_status(get_user(request, response))}

@app.post("/followup")
async def followup(request: Request, response: Response):
    user = get_user(request, response)
    st = get_status(user)
    if not st["is_premium"] and st["remaining"] <= 0:
        raise HTTPException(403, "Günlük soru hakkınız doldu.")

    data = await request.json()
    msg = str(data.get("message", "")).strip()[:3000]
    system = FOLLOW_SYSTEM.format(
        subject=data.get("subject", ""),
        note=data.get("note", "-"),
        solution=data.get("solution", "(yok)")[:6000]
    )
    contents = []
    for turn in data.get("history", []):
        role = "user" if turn["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=turn["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=msg)]))

    answer = ask_ai(system, contents)
    if not st["is_premium"]: consume_quota(user["uid"], user)
    return {"answer": answer, **get_status(get_user(request, response))}

@app.post("/coach")
async def coach(request: Request, response: Response):
    user = get_user(request, response)
    data = await request.json()
    msg = str(data.get("message", "")).strip()[:3000]
    system = COACH_SYSTEM.format(profile=str(data.get("profile", {}))[:800])
    contents = []
    for turn in data.get("history", []):
        role = "user" if turn["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=turn["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=msg)]))

    answer = ask_ai(system, contents, max_tokens=1200)
    return {"answer": answer}

@app.get("/history")
def history(request: Request, response: Response, pdf: int = 0):
    user = get_user(request, response)
    if pdf == 1 and not get_status(user)["is_premium"]:
        raise HTTPException(403, "PDF indirme Premium üyelere özeldir.")
    with closing(db()) as conn:
        rows = conn.execute("SELECT subject,image,answer,created_at FROM questions WHERE uid=? ORDER BY id DESC LIMIT ?",
                            (user["uid"], 200 if pdf else 60)).fetchall()
    return [dict(r) for r in rows]

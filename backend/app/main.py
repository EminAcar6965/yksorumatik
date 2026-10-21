from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from dotenv import load_dotenv
import base64, io, json, os, sqlite3
from contextlib import closing
from datetime import datetime, timezone, timedelta
from pathlib import Path

load_dotenv()

HERE = Path(__file__).resolve().parent
DB_PATH = os.getenv("DB_PATH", str(HERE / "yksorumatik.db"))
MAX_UPLOAD = 10 * 1024 * 1024
SUBJECTS = {"TYT Matematik", "TYT Türkçe", "TYT Fen", "TYT Sosyal", "AYT Matematik", "AYT Edebiyat", "AYT Fen", "AYT Sosyal"}
DAILY_FREE_LIMIT = 3

STATIC_DIR = HERE.parent / "static"
TEMPLATES_DIR = HERE.parent / "static"

app = FastAPI(title="YKS Sorumatik")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

api_key = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=api_key) if api_key else None

ABI_SYSTEM = (
    "Sen 'YKS Mentor'sun: Üniversite sınavına (YKS) hazırlanan lise son sınıf ve mezun öğrencilere yardım eden, deneyimli, akademik ve stratejik bir eğitmensin. "
    "Öğrencilere 'kardeşim' gibi samimi ama 'hocam/öğrencim' ciddiyetinde hitap et. "
    "Soruları adım adım, akademik bir dille çöz. Sadece cevabı verme; **sınav taktikleri (süre yönetimi, eleme yöntemleri, tuzak sorular)** ver. "
    "Matematik ve Fen ifadelerini LaTeX ile yaz: satır içi için $...$, ayrı satır için $$...$$. "
    "Çözümün sonunda konunun önemini ve YKS'de çıkma sıklığını belirt. "
    "Motivasyonu düşükse, ona hedeflerini ve geleceğini hatırlatarak profesyonelce motive et."
)

COACH_SYSTEM = (
    "Sen 'YKS Sınav Koçu'sun: Öğrencilere TYT/AYT net artırma stratejileri, çalışma programları (pomodoro, tekrar takvimleri), "
    "sınav kaygısıyla baş etme ve bölüm seçimi/tercih dönemi konularında rehberlik eden profesyonel bir koçsun. "
    "Somut verilerle konuş, abartıdan kaçın. Plan hazırlarken öğrencinin hedef bölümünü ve mevcut netlerini sor."
)

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with closing(db()) as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS history (
                   id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL,
                   image TEXT NOT NULL, answer TEXT NOT NULL, created_at TEXT NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS users (
                   ip TEXT PRIMARY KEY,
                   daily_count INTEGER DEFAULT 0,
                   last_reset_date TEXT,
                   premium_until TEXT
               )"""
        )
        conn.commit()

init_db()

def get_client_ip(request: Request):
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host

def check_and_update_quota(ip: str):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with closing(db()) as conn:
        user = conn.execute("SELECT * FROM users WHERE ip = ?", (ip,)).fetchone()
        
        if not user:
            conn.execute("INSERT INTO users (ip, daily_count, last_reset_date) VALUES (?, 1, ?)", (ip, today))
            conn.commit()
            return True
            
        if user['premium_until']:
            premium_date = datetime.fromisoformat(user['premium_until'])
            if premium_date > datetime.now(timezone.utc):
                return True

        if user['last_reset_date'] != today:
            conn.execute("UPDATE users SET daily_count = 1, last_reset_date = ? WHERE ip = ?", (today, ip))
            conn.commit()
            return True

        if user['daily_count'] >= DAILY_FREE_LIMIT:
            return False

        conn.execute("UPDATE users SET daily_count = daily_count + 1 WHERE ip = ?", (ip,))
        conn.commit()
        return True

def get_user_status(ip: str):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with closing(db()) as conn:
        user = conn.execute("SELECT * FROM users WHERE ip = ?", (ip,)).fetchone()
        if not user:
            return {"is_premium": False, "remaining": DAILY_FREE_LIMIT}
        
        is_premium = False
        if user['premium_until']:
            premium_date = datetime.fromisoformat(user['premium_until'])
            if premium_date > datetime.now(timezone.utc):
                is_premium = True
                
        count = user['daily_count'] if user['last_reset_date'] == today else 0
        return {"is_premium": is_premium, "remaining": max(0, DAILY_FREE_LIMIT - count)}

def ask_ai(system: str, contents: list, max_tokens: int = 4096) -> str:
    if not client:
        raise HTTPException(500, "Sunucuda GEMINI_API_KEY ayarlanmamış.")
    try:
        response = client.models.generate_content(
            model='gemini-1.5-flash', # 502 hatasını çözmek için en stabil model
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
                temperature=0.6,
            ),
            contents=contents
        )
        return response.text
    except Exception as exc:
        print(f"Yapay zeka hatası: {exc}")
        raise HTTPException(502, f"Sistem Hatası: {str(exc)}")

def prepare_image(raw: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((1600, 1600))
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=85)
        return out.getvalue()
    except Exception:
        raise HTTPException(400, "Fotoğraf okunamadı.")

class ChatTurn(BaseModel):
    role: str
    content: str

class FollowupIn(BaseModel):
    subject: str = "Genel"
    note: str = ""
    solution: str | None = None
    history: list[ChatTurn] = Field(default_factory=list)
    message: str = Field(min_length=1, max_length=1500)

class CoachIn(BaseModel):
    message: str = Field(min_length=1, max_length=1500)
    history: list[ChatTurn] = Field(default_factory=list)
    profile: dict = Field(default_factory=dict)

@app.get("/")
def index():
    return FileResponse(TEMPLATES_DIR / "index.html")

@app.get("/api/status")
def status(request: Request):
    ip = get_client_ip(request)
    return get_user_status(ip)

@app.post("/api/subscribe")
def subscribe(request: Request):
    ip = get_client_ip(request)
    premium_until = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    with closing(db()) as conn:
        conn.execute("UPDATE users SET premium_until = ? WHERE ip = ?", (premium_until, ip))
        conn.commit()
    return {"success": True}

@app.post("/solve")
async def solve(request: Request, file: UploadFile = File(...), subject: str = Form("TYT Matematik"), note: str = Form("")):
    ip = get_client_ip(request)
    if not check_and_update_quota(ip):
        raise HTTPException(403, "Günlük soru hakkınız doldu. Sınırsız çözüm için Premium'a geçebilirsiniz.")
        
    subject = subject if subject in SUBJECTS else "Genel"
    raw = await file.read()
    if not raw: raise HTTPException(400, "Boş dosya.")
    
    jpeg = prepare_image(raw)
    b64 = base64.b64encode(jpeg).decode()

    prompt = f"Ders: {subject}."
    if note.strip(): prompt += f"\nÖğrencinin notu: {note.strip()[:1000]}"
    prompt += "\nFotoğraftaki soruyu YKS formatında çöz ve taktik ver."

    image_part = types.Part.from_bytes(data=jpeg, mime_type="image/jpeg")
    answer = ask_ai(ABI_SYSTEM, contents=[image_part, prompt])

    with closing(db()) as conn:
        conn.execute(
            "INSERT INTO history (subject, image, answer, created_at) VALUES (?, ?, ?, ?)",
            (subject, b64, answer, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()

    return {"answer": answer}

@app.post("/followup")
async def followup(body: FollowupIn, request: Request):
    ip = get_client_ip(request)
    if not check_and_update_quota(ip):
        raise HTTPException(403, "Günlük soru hakkınız doldu. Sınırsız çözüm için Premium'a geçebilirsiniz.")
        
    context = f"Ders: {body.subject}."
    if body.note: context += f"\nÖğrencinin notu: {body.note[:1000]}"
    if body.solution: context += f"\n\nDaha önce verdiğin çözüm:\n{body.solution[:6000]}"
    else: context += "\nÖğrenci fotoğrafsız, yazıyla soruyor."

    contents = [types.Content(role="user", parts=[types.Part(text=context)])]
    for turn in body.history[-10:]:
        role = "user" if turn.role == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=turn.content)]))
    contents.append(types.Content(role="user", parts=[types.Part(text=body.message)]))

    return {"answer": ask_ai(ABI_SYSTEM, contents=contents)}

@app.post("/coach")
def coach(body: CoachIn):
    system = COACH_SYSTEM + "\n\nÖğrenci profili: " + json.dumps(body.profile, ensure_ascii=False)[:1000]
    contents = []
    for turn in body.history[-12:]:
        role = "user" if turn.role == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=turn.content)]))
    contents.append(types.Content(role="user", parts=[types.Part(text=body.message)]))
    
    return {"answer": ask_ai(system, contents=contents, max_tokens=1200)}

@app.get("/history")
def history():
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT subject, image, answer, created_at FROM history ORDER BY id DESC LIMIT 100"
        ).fetchall()
    return [dict(r) for r in rows]
import os, uuid, time, base64, io, jwt, bcrypt, random, string
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, Request, Response, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from PIL import Image, ImageOps
from dotenv import load_dotenv
from pydantic import BaseModel
from supabase import create_client, Client
import boto3
from botocore.client import Config
import resend

load_dotenv()

HERE = os.path.dirname(os.path.abspath(__file__))
API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
SECRET_KEY = os.getenv("JWT_SECRET", "gizli-anahtar-degistir-bunu")
ALGORITHM = "HS256"
DAILY_FREE = 3
PLAN_DAYS = {"daily": 1, "weekly": 7, "monthly": 30, "yearly": 365}

STATIC_DIR = os.path.join(HERE, "..", "static")

app = FastAPI(title="YKS Sorumatik")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

client = genai.Client(api_key=API_KEY) if API_KEY else None

supabase: Client = create_client(os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_ANON_KEY", ""))

s3_client = boto3.client(
    service_name='s3', endpoint_url=os.getenv('R2_ENDPOINT_URL'),
    aws_access_key_id=os.getenv('R2_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('R2_SECRET_ACCESS_KEY'),
    config=Config(signature_version='s3v4'), region_name='auto'
)

# --- Yardımcılar ---
def today(): return datetime.now(timezone(timedelta(hours=3))).date().isoformat()

def hash_password(password: str) -> str: return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
def verify_password(password: str, hashed: str) -> bool: return bcrypt.checkpw(password.encode(), hashed.encode())

def create_token(uid: str, email: str, role: str):
    payload = {"uid": uid, "email": email, "role": role, "exp": datetime.now(timezone.utc) + timedelta(days=7)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def get_user(request: Request, response: Response):
    auth = request.headers.get("Authorization")
    if auth and auth.startswith("Bearer "):
        token = auth.split(" ")[1]
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            uid = payload.get("uid")
            if uid:
                res = supabase.table("users").select("*").eq("uid", uid).execute()
                if res.data and len(res.data) > 0: 
                    user = res.data[0]
                    # Eğer eski kullanıcıysa ve kodu yoksa, anında oluştur ve kaydet
                    if not user.get("referral_code"):
                        new_code = uid[:8].upper()
                        supabase.table("users").update({"referral_code": new_code}).eq("uid", uid).execute()
                        user["referral_code"] = new_code
                    return user
        except Exception: pass

    uid = request.cookies.get("uid", "")
    is_new = False
    if not uid or len(uid) > 64: uid = uuid.uuid4().hex; is_new = True

    res = supabase.table("users").select("*").eq("uid", uid).execute()
    if not res.data or len(res.data) == 0:
        new_user = {"uid": uid, "created_at": datetime.now(timezone.utc).isoformat(), "referral_code": uid[:8].upper()}
        supabase.table("users").insert(new_user).execute()
        user = new_user
    else:
        user = res.data[0]
        # Anonim kullanıcı için de kod yoksa oluştur
        if not user.get("referral_code"):
            new_code = uid[:8].upper()
            supabase.table("users").update({"referral_code": new_code}).eq("uid", uid).execute()
            user["referral_code"] = new_code

    if is_new: response.set_cookie("uid", uid, max_age=60*60*24*365, samesite="Lax", httponly=True)
    return user

def get_status(user):
    is_premium = (user.get("premium_until") or 0) > time.time()
    used = user.get("used_count", 0) if user.get("used_date") == today() else 0
    bonus = user.get("bonus_quota", 0) or 0 # None gelirse 0 yap
    return {
        "is_premium": is_premium,
        "remaining": max(0, DAILY_FREE + bonus - used),
        "plan": user.get("plan", "") if is_premium else "",
        "premium_until": user.get("premium_until", 0) if is_premium else 0,
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "role": user.get("role", "user"),
        "referral_code": user.get("referral_code", ""),
        "bonus_quota": bonus
    }

def consume_quota(uid, user):
    used = user.get("used_count", 0) if user.get("used_date") == today() else 0
    supabase.table("users").update({"used_date": today(), "used_count": used + 1}).eq("uid", uid).execute()

def ask_ai(system: str, contents: list, max_tokens: int = 2000) -> str:
    if not client: raise HTTPException(500, "GEMINI_API_KEY ayarlanmamış.")
    try:
        # Modeli gemini-1.5-flash olarak sabitledik. Ücretli sürüme geçince hızlanacak.
        response = client.models.generate_content(
            model='gemini-1.5-flash',
            config=types.GenerateContentConfig(system_instruction=system, max_output_tokens=max_tokens, temperature=0.6),
            contents=contents
        )
        return response.text
    except Exception as e:
        print(f"🔥 YAPAY ZEKA HATASI: {e}")
        raise HTTPException(502, f"Yapay Zeka Hatası: {str(e)}")

def prepare_image(raw: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(raw)); img = ImageOps.exif_transpose(img).convert("RGB"); img.thumbnail((1600, 1600))
        out = io.BytesIO(); img.save(out, format="JPEG", quality=85); return out.getvalue()
    except: raise HTTPException(400, "Fotoğraf okunamadı.")

def upload_to_r2(file_bytes: bytes, file_name: str):
    try:
        s3_client.put_object(Bucket=os.getenv('R2_BUCKET_NAME'), Key=file_name, Body=file_bytes, ContentType="image/jpeg")
        return f"{os.getenv('R2_PUBLIC_URL')}/{file_name}"
    except Exception as e:
        print(f"R2 Yükleme Hatası: {e}"); return None

# --- Modeller ---
class ChatTurn(BaseModel): role: str; content: str
class AuthIn(BaseModel): email: str; password: str; name: Optional[str] = None; code: Optional[str] = None; referral_code: Optional[str] = None

# --- Promptlar ---
SOLVE_SYSTEM = """Sen YKS (TYT/AYT) öğrencilerine yardım eden sabırlı bir Türk öğretmensin.
- Fotoğraftaki soruyu adım adım, sade Türkçe ile çöz. Matematiksel ifadeleri LaTeX ile yaz.
- Sonda net bir "Cevap: ..." satırı ver. Ayrıca sorunun hangi konuya ait olduğunu [Konu: X] şeklinde belirt."""

FOLLOW_SYSTEM = """Sen YKS öğrencilerine yardım eden sabırlı bir Türk öğretmensin. Kısa, net ve anlaşılır cevap ver.
Bağlam: Ders: {subject} | Not: {note} | Önceki Çözüm: {solution}"""

COACH_SYSTEM = """Sen samimi, destekleyici ve gerçekçi bir YKS sınav koçusun. Türkçe konuş. Kısa, uygulanabilir cevaplar ver. Profil: {profile}"""

# --- Auth ---
@app.post("/api/send-code")
def send_code(body: AuthIn):
    email = body.email.strip().lower()
    if not email or "@" not in email: raise HTTPException(400, "Geçerli bir e-posta girin.")
    
    code = ''.join(random.choices(string.digits, k=6)); expires = int(time.time()) + 300
    
    try:
        supabase.table("verification_codes").delete().eq("email", email).execute()
        supabase.table("verification_codes").insert({"email": email, "code": code, "expires_at": expires}).execute()
    except Exception as e:
        print(f"Supabase Kod Kayıt Hatası: {e}")
        
    print(f"🔥 DOĞRULAMA KODU ({email}): {code}")
    
    resend_api_key = os.getenv("RESEND_API_KEY", "")
    if not resend_api_key:
        print("⚠️ RESEND_API_KEY Render'da ayarlanmamış!")
        return {"ok": True, "message": "Kod oluşturuldu (Loglara bakın)."}

    try:
        resend.api_key = resend_api_key
        resend.Emails.send({
            "from": "Sorumatik <noreply@yksorumatik.com.tr>",
            "to": [email],
            "subject": "Sorumatik Doğrulama Kodu",
            "html": f"<p>Merhaba!</p><p>Sorumatik'e kayıt olmak için doğrulama kodun: <strong>{code}</strong></p><p>Bu kod 5 dakika geçerlidir.</p>"
        })
        print(f"✅ E-posta başarıyla gönderildi: {email}")
    except Exception as e:
        print(f"❌ E-posta gönderim hatası: {e}")
        return {"ok": True, "message": "Kod oluşturuldu (Loglara bakın)."}
        
    return {"ok": True, "message": "Doğrulama kodu e-postanıza gönderildi."}

@app.post("/api/register")
def register(body: AuthIn):
    try:
        email = body.email.strip().lower(); name = (body.name or "").strip(); code = (body.code or "").strip()
        if len(body.password) < 4: raise HTTPException(400, "Şifre en az 4 karakter olmalı.")
        if not name: raise HTTPException(400, "Lütfen adınızı girin.")
        
        vc = supabase.table("verification_codes").select("*").eq("email", email).execute()
        if not vc.data or vc.data[0]["code"] != code or vc.data[0]["expires_at"] < time.time():
            raise HTTPException(400, "Doğrulama kodu hatalı veya süresi geçmiş.")

        existing = supabase.table("users").select("*").eq("email", email).execute()
        if existing.data and len(existing.data) > 0: raise HTTPException(400, "Bu e-posta zaten kayıtlı.")

        uid = uuid.uuid4().hex; role = "admin" if os.getenv("ADMIN_EMAIL", "").lower() == email else "user"
        ref_code = uid[:8].upper()
        
        new_user = {"uid": uid, "email": email, "password_hash": hash_password(body.password), "name": name, "created_at": datetime.now(timezone.utc).isoformat(), "role": role, "referral_code": ref_code, "bonus_quota": 0}
        
        ref_code_input = (body.referral_code or "").strip().upper()
        if ref_code_input == "HOSGELDINYKS":
            new_user["bonus_quota"] = 3
            new_user["premium_until"] = int(time.time() + 86400)
        elif ref_code_input:
            ref_res = supabase.table("users").select("*").eq("referral_code", ref_code_input).execute()
            if ref_res.data and len(ref_res.data) > 0:
                inviter = ref_res.data[0]
                inviter_premium = max(time.time(), inviter.get("premium_until") or 0) + 86400
                supabase.table("users").update({"premium_until": int(inviter_premium)}).eq("uid", inviter["uid"]).execute()
                new_user["bonus_quota"] = 3
                new_user["referred_by"] = inviter["uid"]

        supabase.table("users").insert(new_user).execute()
        supabase.table("verification_codes").delete().eq("email", email).execute()
        
        token = create_token(uid, email, role)
        return {"token": token, "uid": uid, "role": role, "name": name}
    except Exception as e:
        print(f"KAYIT HATASI: {str(e)}")
        raise HTTPException(500, f"Sunucu Hatası: {str(e)}")

@app.post("/api/login")
def login(body: AuthIn):
    email = body.email.strip().lower()
    res = supabase.table("users").select("*").eq("email", email).execute()
    if not res.data or len(res.data) == 0: raise HTTPException(401, "E-posta veya şifre hatalı.")
    user = res.data[0]
    if not user.get("password_hash") or not verify_password(body.password, user["password_hash"]): raise HTTPException(401, "E-posta veya şifre hatalı.")
    token = create_token(user["uid"], user["email"], user["role"])
    return {"token": token, "uid": user["uid"], "role": user["role"], "name": user.get("name", "")}

@app.delete("/api/delete-account")
def delete_account(request: Request, response: Response):
    user = get_user(request, response)
    if not user.get("email"): raise HTTPException(400, "Giriş yapmış bir hesap bulunamadı.")
    supabase.table("users").delete().eq("uid", user["uid"]).execute()
    supabase.table("questions").delete().eq("uid", user["uid"]).execute()
    return {"ok": True}

# --- Uygulama ---
@app.get("/")
def index(): return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/api/status")
def api_status(request: Request, response: Response): return get_status(get_user(request, response))

@app.get("/api/analytics")
def api_analytics(request: Request, response: Response):
    user = get_user(request, response)
    res = supabase.table("questions").select("subject, topic").eq("uid", user["uid"]).execute()
    if not res.data: return {"total": 0, "subjects": {}, "topics": {}}
    
    subjects = {}; topics = {}
    for q in res.data:
        sub = q.get("subject", "Diğer")
        subjects[sub] = subjects.get(sub, 0) + 1
        top = q.get("topic", "Genel")
        topics[top] = topics.get(top, 0) + 1
        
    return {"total": len(res.data), "subjects": subjects, "topics": topics}

@app.post("/api/subscribe")
async def api_subscribe(request: Request, response: Response):
    user = get_user(request, response)
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    plan = data.get("plan", "monthly"); days = PLAN_DAYS.get(plan)
    if not days: raise HTTPException(400, "Geçersiz plan.")
    base = max(time.time(), user.get("premium_until") or 0)
    supabase.table("users").update({"premium_until": int(base + days * 86400), "plan": plan}).eq("uid", user["uid"]).execute()
    return {"ok": True, **get_status(get_user(request, response))}

@app.post("/solve")
async def solve(request: Request, response: Response, file: UploadFile = File(...), subject: str = Form("TYT Matematik"), note: str = Form("")):
    user = get_user(request, response); st = get_status(user)
    if not st["is_premium"] and st["remaining"] <= 0: raise HTTPException(403, "Günlük soru hakkınız doldu.")
    raw = await file.read()
    if not raw: raise HTTPException(400, "Fotoğraf bulunamadı.")
    
    jpeg = prepare_image(raw); image_part = types.Part.from_bytes(data=jpeg, mime_type="image/jpeg")
    prompt = f"Ders: {subject}\nNot: {note}\nBu soruyu çöz."
    answer = ask_ai(SOLVE_SYSTEM, contents=[image_part, prompt])
    
    topic = "Genel"
    if "[Konu:" in answer:
        try: topic = answer.split("[Konu:")[1].split("]")[0].strip()
        except: pass
        
    file_name = f"questions/{user['uid']}_{int(time.time())}.jpg"
    image_url = upload_to_r2(jpeg, file_name)
    
    new_q = {"uid": user["uid"], "subject": subject, "topic": topic, "image": image_url or "error", "answer": answer, "created_at": datetime.now(timezone.utc).isoformat()}
    supabase.table("questions").insert(new_q).execute()
    
    if not st["is_premium"]: consume_quota(user["uid"], user)
    return {"answer": answer, **get_status(get_user(request, response))}

@app.post("/followup")
async def followup(request: Request, response: Response):
    user = get_user(request, response); st = get_status(user)
    if not st["is_premium"] and st["remaining"] <= 0: raise HTTPException(403, "Günlük soru hakkınız doldu.")
    data = await request.json(); msg = str(data.get("message", "")).strip()[:3000]
    system = FOLLOW_SYSTEM.format(subject=data.get("subject", ""), note=data.get("note", "-"), solution=data.get("solution", "(yok)")[:6000])
    contents = []
    for turn in data.get("history", []):
        contents.append(types.Content(role="user" if turn["role"]=="user" else "model", parts=[types.Part(text=turn["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=msg)]))
    answer = ask_ai(system, contents)
    if not st["is_premium"]: consume_quota(user["uid"], user)
    return {"answer": answer, **get_status(get_user(request, response))}

@app.post("/coach")
async def coach(request: Request, response: Response):
    user = get_user(request, response); data = await request.json()
    msg = str(data.get("message", "")).strip()[:3000]
    system = COACH_SYSTEM.format(profile=str(data.get("profile", {}))[:800])
    contents = []
    for turn in data.get("history", []):
        contents.append(types.Content(role="user" if turn["role"]=="user" else "model", parts=[types.Part(text=turn["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=msg)]))
    answer = ask_ai(system, contents, max_tokens=1200)
    return {"answer": answer}

@app.get("/history")
def history(request: Request, response: Response, pdf: int = 0):
    user = get_user(request, response)
    if pdf == 1 and not get_status(user)["is_premium"]: raise HTTPException(403, "PDF indirme Premium üyelere özeldir.")
    res = supabase.table("questions").select("*").eq("uid", user["uid"]).order("id", desc=True).limit(200 if pdf else 60).execute()
    return res.data
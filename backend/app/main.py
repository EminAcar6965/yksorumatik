import os, base64, sqlite3, uuid, time
from datetime import datetime, timezone, timedelta
import requests
from flask import Flask, request, jsonify, g

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE, "sorumatik.db"))
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
FREE_DAILY = 3
PLAN_DAYS = {"weekly": 7, "monthly": 30, "yearly": 365}
# DİKKAT: Gerçek ödeme (iyzico/PayTR/Stripe) bağlayana kadar demo modudur.
# Canlıya alırken ALLOW_FAKE_PAYMENT=0 yap, yoksa herkes ücretsiz premium olur.
ALLOW_FAKE_PAYMENT = os.environ.get("ALLOW_FAKE_PAYMENT", "1") == "1"

app = Flask(__name__, static_folder=PUBLIC, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024


# ---------------- DB ----------------
def q(sql, args=(), one=False, commit=False):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(sql, args)
        if commit:
            conn.commit()
            return None
        return cur.fetchone() if one else cur.fetchall()
    finally:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS users(
        uid TEXT PRIMARY KEY,
        premium_until INTEGER DEFAULT 0,
        plan TEXT DEFAULT '',
        used_date TEXT DEFAULT '',
        used_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS questions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT, subject TEXT, image TEXT, answer TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_q_uid ON questions(uid);
    """)
    conn.commit()
    conn.close()


def today():
    return datetime.now(timezone(timedelta(hours=3))).date().isoformat()


def user():
    if not hasattr(g, "uid"):
        uid = request.cookies.get("uid", "")
        g.new_uid = False
        if not uid or len(uid) > 64:
            uid = uuid.uuid4().hex
            g.new_uid = True
        g.uid = uid
        if not q("SELECT 1 FROM users WHERE uid=?", (uid,), one=True):
            q("INSERT INTO users(uid) VALUES(?)", (uid,), commit=True)
    return q("SELECT * FROM users WHERE uid=?", (g.uid,), one=True)


@app.after_request
def set_cookie(resp):
    if getattr(g, "new_uid", False):
        resp.set_cookie("uid", g.uid, max_age=60 * 60 * 24 * 365, samesite="Lax", httponly=True)
    return resp


def status(u):
    is_premium = (u["premium_until"] or 0) > time.time()
    used = u["used_count"] if u["used_date"] == today() else 0
    return {
        "is_premium": is_premium,
        "remaining": max(0, FREE_DAILY - used),
        "plan": u["plan"] if is_premium else "",
        "premium_until": u["premium_until"] if is_premium else 0,
    }


def consume(u):
    used = u["used_count"] if u["used_date"] == today() else 0
    q("UPDATE users SET used_date=?, used_count=? WHERE uid=?", (today(), used + 1, g.uid), commit=True)


def limit_reached():
    return jsonify(error="Günlük ücretsiz soru hakkın doldu. Sınırsız çözüm için Premium'a geç."), 403


# ---------------- AI ----------------
class AIError(Exception):
    def __init__(self, msg, detail=""):
        super().__init__(msg)
        self.msg, self.detail = msg, detail


def call_ai(system, messages, max_tokens=2000):
    if not API_KEY:
        raise AIError("Sunucuda ANTHROPIC_API_KEY ayarlı değil.", "API anahtarını ortam değişkeni olarak ekle.")
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": MODEL, "max_tokens": max_tokens, "system": system, "messages": messages},
            timeout=120,
        )
    except requests.RequestException as e:
        raise AIError("Yapay zeka servisine bağlanılamadı.", str(e)[:200])
    if r.status_code != 200:
        raise AIError("Yapay zeka şu an cevap veremiyor.", f"{r.status_code}: {r.text[:300]}")
    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if not text:
        raise AIError("Boş cevap geldi, tekrar dene.")
    return text


def clean_history(hist, new_msg):
    out = []
    for m in hist or []:
        if not isinstance(m, dict):
            continue
        role, c = m.get("role"), m.get("content")
        if role not in ("user", "assistant") or not isinstance(c, str) or not c.strip():
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n" + c
        else:
            out.append({"role": role, "content": c})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if out and out[-1]["role"] == "user":
        out[-1]["content"] += "\n" + new_msg
    else:
        out.append({"role": "user", "content": new_msg})
    return out


SOLVE_SYSTEM = """Sen YKS (TYT/AYT) öğrencilerine yardım eden sabırlı bir Türk öğretmensin.
- Fotoğraftaki soruyu adım adım, sade Türkçe ile çöz. Önce sorunun ne istediğini kısaca belirt.
- Matematiksel ifadeleri LaTeX ile yaz: satır içi için $...$, ayrı satır için $$...$$.
- Sonda net bir "Cevap: ..." satırı ver ve varsa püf noktasını 1-2 cümleyle söyle.
- Fotoğraf okunamıyorsa bunu dürüstçe söyle ve daha net fotoğraf iste. Emin olmadığın şeyi uydurma."""

FOLLOW_SYSTEM = """Sen YKS öğrencilerine yardım eden sabırlı bir Türk öğretmensin.
Öğrenci bir sorunun çözümü hakkında takip sorusu soruyor. Kısa, net ve anlaşılır cevap ver.
Matematiği LaTeX ile yaz ($...$ veya $$...$$). Gerekirse örnek ver.
Bağlam:
Ders: {subject}
Öğrencinin notu: {note}
Daha önceki çözüm:
{solution}"""

COACH_SYSTEM = """Sen samimi, destekleyici ve gerçekçi bir YKS sınav koçusun. Türkçe konuş.
Cevapların kısa, uygulanabilir ve somut olsun; gerektiğinde madde işaretleri kullan. Tıbbi/psikolojik teşhis koyma.
Öğrenci profili: {profile}"""


# ---------------- Sayfalar ----------------
@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/status")
def api_status():
    return jsonify(status(user()))


@app.post("/api/subscribe")
def api_subscribe():
    u = user()
    if not ALLOW_FAKE_PAYMENT:
        return jsonify(error="Ödeme sistemi henüz aktif değil."), 501
    plan = (request.get_json(silent=True) or {}).get("plan", "weekly")
    days = PLAN_DAYS.get(plan)
    if not days:
        return jsonify(error="Geçersiz plan."), 400
    base = max(time.time(), u["premium_until"] or 0)
    q("UPDATE users SET premium_until=?, plan=? WHERE uid=?", (int(base + days * 86400), plan, g.uid), commit=True)
    return jsonify(ok=True, **status(user()))


@app.post("/solve")
def solve():
    u = user()
    st = status(u)
    if not st["is_premium"] and st["remaining"] <= 0:
        return limit_reached()
    f = request.files.get("file")
    raw = f.read() if f else b""
    if not raw:
        return jsonify(error="Fotoğraf bulunamadı."), 400
    mime = f.mimetype if f.mimetype in ("image/jpeg", "image/png", "image/webp", "image/gif") else "image/jpeg"
    b64 = base64.b64encode(raw).decode()
    subject = (request.form.get("subject") or "TYT Matematik")[:40]
    note = (request.form.get("note") or "")[:1000]
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
        {"type": "text", "text": f"Ders: {subject}\nÖğrencinin notu: {note or '-'}\n\nBu soruyu çöz."},
    ]
    try:
        answer = call_ai(SOLVE_SYSTEM, [{"role": "user", "content": content}], 2500)
    except AIError as e:
        return jsonify(error=e.msg, detail=e.detail), 502
    q("INSERT INTO questions(uid,subject,image,answer,created_at) VALUES(?,?,?,?,?)",
      (g.uid, subject, b64, answer, datetime.utcnow().isoformat() + "Z"), commit=True)
    if not st["is_premium"]:
        consume(u)
    return jsonify(answer=answer, **status(user()))


@app.post("/followup")
def followup():
    u = user()
    st = status(u)
    if not st["is_premium"] and st["remaining"] <= 0:
        return limit_reached()
    d = request.get_json(silent=True) or {}
    msg = str(d.get("message", "")).strip()[:3000]
    if not msg:
        return jsonify(error="Mesaj boş."), 400
    system = FOLLOW_SYSTEM.format(
        subject=str(d.get("subject", ""))[:40],
        note=str(d.get("note") or "-")[:1000],
        solution=str(d.get("solution") or "(henüz çözüm yok)")[:6000],
    )
    try:
        answer = call_ai(system, clean_history(d.get("history"), msg), 1800)
    except AIError as e:
        return jsonify(error=e.msg, detail=e.detail), 502
    if not st["is_premium"]:
        consume(u)
    return jsonify(answer=answer, **status(user()))


@app.post("/coach")
def coach():
    user()
    d = request.get_json(silent=True) or {}
    msg = str(d.get("message", "")).strip()[:3000]
    if not msg:
        return jsonify(error="Mesaj boş."), 400
    system = COACH_SYSTEM.format(profile=str(d.get("profile", {}))[:800])
    try:
        answer = call_ai(system, clean_history(d.get("history"), msg), 1200)
    except AIError as e:
        return jsonify(error=e.msg, detail=e.detail), 502
    return jsonify(answer=answer)


@app.get("/history")
def history():
    u = user()
    pdf = request.args.get("pdf") == "1"
    if pdf and not status(u)["is_premium"]:
        return jsonify(error="PDF indirme Premium üyelere özeldir."), 403
    rows = q("SELECT id,subject,image,answer,created_at FROM questions WHERE uid=? ORDER BY id DESC LIMIT ?",
             (g.uid, 200 if pdf else 60))
    return jsonify([dict(r) for r in rows])


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
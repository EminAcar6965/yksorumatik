// ============================================================
// YKS Sorumatik - Aurora / Glassmorphism Arayüz Mantığı
// ============================================================

const $ = (id) => document.getElementById(id);

const AVATAR = 'https://api.dicebear.com/7.x/bottts/svg?seed=YKS_Mentor';
const ABI_AVATAR = `<div class="msg-avatar"><img src="${AVATAR}" alt="YKS Mentor"></div>`;
const COACH_AVATAR = '<div class="msg-avatar" style="background:var(--neon-blue);">🧠</div>';

const MATH_OPTIONS = {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
    throwOnError: false,
};
const SUBJECTS = ['TYT Matematik', 'TYT Türkçe', 'TYT Fen', 'TYT Sosyal', 'AYT Matematik', 'AYT Edebiyat', 'AYT Fen', 'AYT Sosyal'];

// ---------- Yerel Depolama ----------
const store = {
    get(key, fallback) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
        catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
    },
};

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nl2br(str) { return escapeHtml(str).replace(/\n/g, '<br>'); }
function todayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

let toastTimer;
function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function renderMath(el) { if (typeof renderMathInElement === 'function') renderMathInElement(el, MATH_OPTIONS); }
function scrollEnd(container) { requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; }); }
const isDesktop = window.matchMedia('(pointer: fine)').matches;

async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await response.json(); } catch { }
    if (!response.ok || !data.answer) {
        const msg = [data.error, data.detail].find((m) => typeof m === 'string');
        throw new Error(msg || 'Şu an cevap hazırlanamadı.');
    }
    return data.answer;
}

// ---------- KULLANICI DURUMU ----------
let userStatus = { is_premium: false, remaining: 3 };

async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        if (res.ok) { userStatus = await res.json(); updateQuotaUI(); }
    } catch (e) { console.error("Durum alınamadı", e); }
}

function updateQuotaUI() {
    const text = $('quota-text');
    if (!text) return;
    if (userStatus.is_premium) {
        text.innerHTML = 'Sınırsız 💎';
        text.style.color = 'var(--neon-blue)';
    } else {
        text.innerHTML = `Hakkın: <strong>${userStatus.remaining}</strong>`;
        text.style.color = userStatus.remaining === 0 ? 'var(--coral)' : 'var(--accent)';
    }
}

// ---------- MESAJ BALONLARI ----------
function messageHtml({ role, name, body, cls = '', avatar = ABI_AVATAR }) {
    if (role === 'user') {
        return `<div class="message user"><div class="msg-bubble ${cls}">${body}</div></div>`;
    }
    return `<div class="message ai ${cls}">${avatar}<div class="msg-bubble">${body}</div></div>`;
}

function addMessage(container, opts) {
    container.insertAdjacentHTML('beforeend', messageHtml(opts));
    const el = container.lastElementChild; scrollEnd(container); return el;
}

function addTyping(container, avatar, name) {
    return addMessage(container, { role: 'ai', avatar, name, body: '<div class="typing-indicator"><span></span><span></span><span></span></div>' });
}

function addAiMarkdown(container, text, avatar, name) {
    const el = addMessage(container, { role: 'ai', avatar, name, body: '', cls: 'response-text' });
    const bubble = el.querySelector('.msg-bubble');
    bubble.innerHTML = marked.parse(text); renderMath(bubble); scrollEnd(container); return el;
}

function addQuickReplies(container, items) {
    const row = document.createElement('div'); row.className = 'quick-replies';
    row.style = "display:flex; gap:8px; margin-top:8px; margin-left:48px; flex-wrap:wrap;";
    items.forEach((item) => {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = item.label;
        btn.style = "padding:8px 12px; border-radius:8px; background:var(--glass-bg); border:1px solid var(--glass-border); color:#fff; cursor:pointer; font-size:12px;";
        btn.addEventListener('click', () => { row.remove(); item.action(); });
        row.appendChild(btn);
    });
    container.appendChild(row); scrollEnd(container);
}

// ---------- SAYAÇLAR ----------
function dayCounter(key) {
    return {
        get() { const v = store.get(key, { date: null, count: 0 }); return v.date === todayKey() ? v.count : 0; },
        bump() { store.set(key, { date: todayKey(), count: this.get() + 1 }); },
    };
}
const doneCounter = dayCounter('yks_done');
const pomoCounter = dayCounter('yks_pomo');

function getStreak() {
    const s = store.get('yks_streak', { count: 0, last: null });
    if (!s.last) return 0;
    const y = new Date(); y.setDate(y.getDate() - 1);
    return (s.last === todayKey() || s.last === todayKey(y)) ? s.count : 0;
}
function touchStreak() {
    const s = store.get('yks_streak', { count: 0, last: null });
    if (s.last === todayKey()) return;
    const y = new Date(); y.setDate(y.getDate() - 1);
    s.count = s.last === todayKey(y) ? s.count + 1 : 1;
    s.last = todayKey(); store.set('yks_streak', s); renderStats();
}
function getGoal() { return store.get('yks_goal', 5); }
function daysLeft() {
    const s = store.get('yks_exam', '');
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((target - now) / 86400000));
}
function getProfile() {
    return {
        name: store.get('yks_name', ''), examDate: store.get('yks_exam', ''), daysLeft: daysLeft(),
        streak: getStreak(), dailyGoal: getGoal(), doneToday: doneCounter.get(),
        pomodorosToday: pomoCounter.get(), mood: (store.get('yks_mood', {}).date === todayKey()) ? store.get('yks_mood').key : '',
    };
}

// ---------- SEKME GEÇİŞLERİ ----------
function switchTab(tabId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    $('view-' + tabId).classList.add('active');
    document.querySelector(`.nav-item[data-tab="${tabId}"]`).classList.add('active');
    
    if (tabId === 'archive') loadArchive();
    if (tabId === 'coach') renderCoachPanel();
    if (tabId === 'home') scrollEnd($('chat-history'));
}
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---------- 1) SORU ÇÖZ ----------
const cameraInput = $('camera-input'), galleryInput = $('gallery-input');
const solveBtn = $('solve-btn'), messageInput = $('message-input'), chatHistory = $('chat-history');
const subjectChips = $('subject-chips');

let selectedFile = null, selectedSubject = 'TYT Matematik', sending = false;
let thread = { subject: 'TYT Matematik', note: '', solution: null, history: [] };

function updateSendState() { solveBtn.disabled = sending || (!selectedFile && messageInput.value.trim() === ''); }

subjectChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    selectedSubject = chip.dataset.value;
    subjectChips.querySelectorAll('.chip').forEach((c) => {
        const active = c === chip;
        c.classList.toggle('active', active); c.setAttribute('aria-checked', active);
    });
});

function handleFile(file, inputEl) {
    if (!file || !file.type.startsWith('image/')) { showToast('Lütfen bir fotoğraf seç.'); return; }
    selectedFile = file;
    // Fotoğraf seçildiğinde kullanıcıya geri bildirim verelim
    messageInput.value = ''; // Input'u temizle
    messageInput.placeholder = "Fotoğraf seçildi, göndermek için tıkla...";
    updateSendState(); 
    if (inputEl) inputEl.value = '';
}
cameraInput.addEventListener('change', (e) => handleFile(e.target.files[0], cameraInput));
galleryInput.addEventListener('change', (e) => handleFile(e.target.files[0], galleryInput));

messageInput.addEventListener('input', () => { 
    messageInput.placeholder = 'Takıldığın yeri yaz...';
    updateSendState(); 
});
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && isDesktop) { e.preventDefault(); if (!solveBtn.disabled) sendMessage(); }
});
solveBtn.addEventListener('click', sendMessage);

function setSending(state) { sending = state; messageInput.disabled = state; updateSendState(); }

async function sendMessage() {
    if (sending) return;
    const text = messageInput.value.trim(); if (!selectedFile && !text) return;
    
    if (!userStatus.is_premium && userStatus.remaining <= 0) {
        showToast("Günlük soru hakkınız doldu. Sınırsız çözüm için Premium'a geçin.");
        switchTab('premium'); return;
    }

    messageInput.placeholder = 'Takıldığın yeri yaz...';
    if (selectedFile) await solveImage(text); else await askFollowup(text);
}

async function solveImage(note) {
    const fileToSend = selectedFile, subject = selectedSubject;
    
    addMessage(chatHistory, { 
        role: 'user', 
        body: `${note ? `<div>${nl2br(note)}</div>` : ''}<div style="font-size:12px; color:#94a3b8; margin-top:4px;">📷 Fotoğraf gönderildi</div>` 
    });
    
    messageInput.value = ''; clearImage(); setSending(true); touchStreak();

    const typing = addTyping(chatHistory, ABI_AVATAR, 'YKS Mentor');
    const formData = new FormData();
    formData.append('file', fileToSend); formData.append('subject', subject); formData.append('note', note);

    try {
        const response = await fetch('/solve', { method: 'POST', body: formData });
        const data = await response.json().catch(() => ({}));
        typing.remove();

        if (!response.ok || !data.answer) {
            const msg = [data.error, data.detail].find((m) => typeof m === 'string') || 'Çözüm hazırlanamadı.';
            if (response.status === 403) { showToast("Hakkınız doldu."); switchTab('premium'); }
            addMessage(chatHistory, { role: 'ai', body: escapeHtml(msg), cls: 'error' });
        } else {
            thread = { subject, note, solution: data.answer, history: [] };
            addAiMarkdown(chatHistory, data.answer); addFeedbackRow();
            if (!userStatus.is_premium) { userStatus.remaining = Math.max(0, userStatus.remaining - 1); updateQuotaUI(); }
        }
    } catch {
        typing.remove(); addMessage(chatHistory, { role: 'ai', body: 'Bağlantı kurulamadı.', cls: 'error' });
    } finally { setSending(false); scrollEnd(chatHistory); }
}

async function askFollowup(text) {
    thread.subject = thread.solution ? thread.subject : selectedSubject;
    addMessage(chatHistory, { role: 'user', body: nl2br(text), cls: 'text-only' });
    messageInput.value = ''; setSending(true);

    const typing = addTyping(chatHistory, ABI_AVATAR, 'YKS Mentor');
    try {
        const answer = await postJson('/followup', { subject: thread.subject, note: thread.note, solution: thread.solution, history: thread.history.slice(-10), message: text });
        typing.remove(); thread.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
        addAiMarkdown(chatHistory, answer); addFeedbackRow();
        if (!userStatus.is_premium) { userStatus.remaining = Math.max(0, userStatus.remaining - 1); updateQuotaUI(); }
    } catch (err) {
        typing.remove();
        if (err.message.includes("403") || err.message.includes("doldu")) { showToast("Hakkınız doldu."); switchTab('premium'); }
        addMessage(chatHistory, { role: 'ai', body: escapeHtml(err.message), cls: 'error' });
    } finally { setSending(false); scrollEnd(chatHistory); }
}

function addFeedbackRow() {
    const row = document.createElement('div'); row.className = 'feedback-row';
    row.style = "display:flex; gap:8px; align-items:center; margin-left:48px; margin-top:8px;";
    row.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">Anlatım net oldu mu?</span>
                     <button type="button" class="fb yes" style="padding:4px 10px; border-radius:12px; border:1px solid #10b981; background:rgba(16,185,129,0.1); color:#10b981; cursor:pointer; font-size:12px;">✅ Anlaşıldı</button>
                     <button type="button" class="fb no" style="padding:4px 10px; border-radius:12px; border:1px solid #f59e0b; background:rgba(245,158,11,0.1); color:#f59e0b; cursor:pointer; font-size:12px;">🤔 Anlaşılmadı</button>`;
    chatHistory.appendChild(row); scrollEnd(chatHistory);
    row.querySelector('.yes').addEventListener('click', () => { row.remove(); onUnderstood(); });
    row.querySelector('.no').addEventListener('click', () => { row.remove(); onNotUnderstood(); });
}

const PRAISE = ['Harika! Bu soru artık senin. 💪', 'Süper! Netlerin artıyor. 🎉', 'Tamamdır, bir soruyu daha hallettik! 🚀'];
function onUnderstood() {
    addMessage(chatHistory, { role: 'user', body: 'Anlaşıldı ✅', cls: 'text-only' });
    doneCounter.bump(); touchStreak(); renderStats();
    const goal = getGoal(), done = doneCounter.get();
    let extra = `Bugün ${done} soruyu anlayarak çözdün.`;
    if (done === goal) extra = '🎯 Günlük hedefini tamamladın, tebrikler!';
    else if (done < goal) extra += ` Hedefe ${goal - done} soru kaldı.`;
    const msg = PRAISE[Math.floor(Math.random() * PRAISE.length)];
    addMessage(chatHistory, { role: 'ai', body: `${msg}<br><br>${escapeHtml(extra)}` });
    addQuickReplies(chatHistory, [
        { label: '🔁 Benzer soru ver', action: () => quickSend('Buna benzer, biraz daha zor bir soru ver.') },
        { label: '📷 Yeni soru ekle', action: () => cameraInput.click() },
    ]);
}

function onNotUnderstood() {
    addMessage(chatHistory, { role: 'user', body: 'Anlaşılmadı 🤔', cls: 'text-only' });
    addMessage(chatHistory, { role: 'ai', body: 'Sorun değil, birlikte netleştirelim. 💪<br>Hangi kısımda takıldın?' });
    addQuickReplies(chatHistory, [
        { label: 'Daha basit anlat', action: () => quickSend('Bunu daha basit ve kısa cümlelerle anlat.') },
        { label: 'Başka yoldan çöz', action: () => quickSend('Bu soruyu başka bir yöntemle çöz.') },
    ]);
    messageInput.focus();
}
function quickSend(text) { messageInput.value = text; sendMessage(); }

function clearImage() {
    selectedFile = null; cameraInput.value = ''; galleryInput.value = '';
    messageInput.placeholder = 'Takıldığın yeri yaz...';
    updateSendState();
}

// ---------- 2) KOÇ PANELİ VE SOHBETİ ----------
const coachMessages = $('coach-messages'), coachInput = $('coach-input'), coachSend = $('coach-send');
let coachHistory = [], coachSending = false;

const DAILY_LINES = ['Küçük adımlar bile seni hedefine taşır.', 'Bugünkü çalışman, yarınki netlerindir.', 'Yanlış yaptığın soru, öğrenmeye hazır olduğun yerdir.', 'Mükemmel olmak zorunda değilsin. Dünden iyi olmak yeter.'];
const MOOD_FALLBACK = { 'yorgun': 'Yorgun hissetmen normal. Hedefi küçült: 2-3 soru çöz, sonra dinlen.', 'kaygılı': 'Kaygı, önemsediğin için var. Derin bir nefes al, sadece bugüne odaklan.', 'iyi': 'Güzel! Bu enerjiyle en zorlandığın konudan bir soru çöz.', 'çok motive': 'Enerjin süper! 🚀 Hemen bir Pomodoro başlat.' };

function greeting() {
    const h = new Date().getHours();
    const part = h < 6 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
    const name = store.get('yks_name', '');
    return name ? `${part}, ${name}! 👋` : `${part}! 👋`;
}

function renderStats() {
    // Dairesel ilerleme çubuğu hesaplaması
    const goal = getGoal(), done = doneCounter.get();
    const percent = Math.min(100, Math.round((done / goal) * 100));
    const circle = $('goal-circle');
    if (circle) {
        const radius = 40;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (percent / 100) * circumference;
        circle.style.strokeDasharray = `${circumference}`;
        circle.style.strokeDashoffset = offset;
    }
    
    $('stat-streak').textContent = getStreak();
    $('stat-goal').textContent = `${Math.min(done, 99)}/${goal}`;
    
    const left = daysLeft();
    $('stat-exam').textContent = left === null ? '–' : left;
    $('exam-date').value = store.get('yks_exam', '');
    $('pomo-count').textContent = `Bugün ${pomoCounter.get()} tur`;
    $('greeting-text').textContent = greeting();
}

function renderCoachPanel() {
    renderStats();
    const mood = store.get('yks_mood', {});
    document.querySelectorAll('.mood-btn').forEach((b) => b.classList.toggle('active', mood.date === todayKey() && mood.key === b.dataset.mood));
}

// İsim kaydetme ve hedef ayarları
$('name-save').addEventListener('click', () => { const name = $('name-input').value.trim(); if (!name) return; store.set('yks_name', name); renderStats(); showToast(`Memnun oldum ${name}! 🤝`); });
$('goal-minus').addEventListener('click', () => { store.set('yks_goal', Math.max(1, getGoal() - 1)); renderStats(); });
$('goal-plus').addEventListener('click', () => { store.set('yks_goal', Math.min(50, getGoal() + 1)); renderStats(); });
$('exam-date').addEventListener('change', (e) => { store.set('yks_exam', e.target.value); renderStats(); });

// Mood tıklama
$('mood-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mood-btn'); if (!btn) return;
    const key = btn.dataset.mood; store.set('yks_mood', { date: todayKey(), key });
    document.querySelectorAll('.mood-btn').forEach((b) => b.classList.toggle('active', b === btn));
    
    const note = $('coach-note'); note.classList.remove('hidden'); note.textContent = 'Koç yazıyor...';
    try {
        const answer = await postJson('/coach', { message: `Bugün ruh halim: ${key}. Bana 2-3 cümlelik, samimi ve uygulanabilir bir motivasyon mesajı yaz.`, history: [], profile: getProfile() });
        note.innerHTML = marked.parse(answer);
    } catch { note.textContent = MOOD_FALLBACK[key]; }
});

// Hızlı sorular
document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        coachInput.value = btn.dataset.prompt;
        coachSend.disabled = false;
        coachSend.click();
    });
});

// Koç Sohbeti
function updateCoachSend() { coachSend.disabled = coachSending || coachInput.value.trim() === ''; }
coachInput.addEventListener('input', () => { updateCoachSend(); });
coachInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && isDesktop) { e.preventDefault(); if (!coachSend.disabled) sendCoach(coachInput.value.trim()); } });
coachSend.addEventListener('click', () => sendCoach(coachInput.value.trim()));

async function sendCoach(text) {
    if (!text || coachSending) return;
    addMessage(coachMessages, { role: 'user', body: nl2br(text), cls: 'text-only' });
    coachInput.value = ''; coachSending = true; updateCoachSend();
    
    const typing = addTyping(coachMessages, COACH_AVATAR, 'Sınav Koçu');
    try {
        const answer = await postJson('/coach', { message: text, history: coachHistory.slice(-12), profile: getProfile() });
        typing.remove(); coachHistory.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
        addAiMarkdown(coachMessages, answer, COACH_AVATAR, 'Sınav Koçu');
    } catch (err) {
        typing.remove(); addMessage(coachMessages, { role: 'ai', avatar: COACH_AVATAR, name: 'Sınav Koçu', body: escapeHtml(err.message), cls: 'error' });
    } finally { coachSending = false; updateCoachSend(); scrollEnd(coachMessages); }
}

// ---------- Pomodoro (25/5) ----------
const pomo = { mode: 'focus', total: 25 * 60, remaining: 25 * 60, running: false, endAt: 0, timer: null };
function drawPomo() {
    const m = String(Math.floor(pomo.remaining / 60)).padStart(2, '0');
    const s = String(pomo.remaining % 60).padStart(2, '0');
    $('pomo-time').textContent = `${m}:${s}`;
    $('pomo-toggle').textContent = pomo.running ? 'Duraklat' : (pomo.remaining < pomo.total ? 'Devam et' : 'Başlat');
}
function setPomoMode() { clearInterval(pomo.timer); pomo.running = false; pomo.remaining = pomo.total; drawPomo(); }
function pomoTick() {
    pomo.remaining = Math.max(0, Math.round((pomo.endAt - Date.now()) / 1000));
    if (pomo.remaining === 0) {
        clearInterval(pomo.timer); pomo.running = false;
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        pomoCounter.bump(); renderStats(); showToast('Tur tamam! 🎉 Mola verebilirsin.');
        setPomoMode();
    }
    drawPomo();
}
$('pomo-toggle').addEventListener('click', () => {
    if (pomo.running) { clearInterval(pomo.timer); pomo.running = false; }
    else { pomo.running = true; pomo.endAt = Date.now() + pomo.remaining * 1000; pomo.timer = setInterval(pomoTick, 250); }
    drawPomo();
});
$('pomo-reset').addEventListener('click', setPomoMode);

// ---------- 3) ARŞİV ----------
let archiveData = [], archiveFilter = 'Hepsi';
function renderArchiveFilter() {
    const names = ['Hepsi', ...SUBJECTS.filter((s) => archiveData.some((q) => q.subject === s))];
    $('archive-filter').innerHTML = names.map((n) => `<button type="button" class="chip ${n === archiveFilter ? 'active' : ''}" data-filter="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
}
$('archive-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    archiveFilter = chip.dataset.filter; renderArchiveFilter(); renderArchiveList();
});
function renderArchiveList() {
    const archiveList = $('archive-list');
    const items = archiveFilter === 'Hepsi' ? archiveData : archiveData.filter((q) => q.subject === archiveFilter);
    if (items.length === 0) { archiveList.innerHTML = `<div class="glass-card" style="text-align:center; color:var(--text-muted);">📭 Burada henüz soru yok.</div>`; return; }
    
    archiveList.innerHTML = items.map((item, i) => {
        const date = new Date(item.created_at).toLocaleDateString('tr-TR');
        return `<div class="glass-card" style="margin-bottom:16px;">
                    <img src="data:image/jpeg;base64,${item.image}" style="width:100%; max-height:250px; object-fit:contain; border-radius:12px; margin-bottom:12px; background:rgba(0,0,0,0.3);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="background:var(--primary); padding:4px 10px; border-radius:6px; font-size:12px; font-weight:600;">${escapeHtml(item.subject)}</span>
                        <span style="font-size:12px; color:var(--text-muted);">${date}</span>
                    </div>
                    <button type="button" class="archive-toggle" data-index="${i}" style="width:100%; padding:10px; border-radius:8px; border:1px solid var(--glass-border); background:var(--glass-bg); color:#fff; cursor:pointer; margin-bottom:8px;">Çözümü göster</button>
                    <div class="archive-answer hidden" id="answer-${i}" style="font-size:14px; line-height:1.6; margin-top:8px;">${marked.parse(item.answer)}</div>
                </div>`;
    }).join('');
    
    archiveList.querySelectorAll('.archive-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
            const answer = $('answer-' + btn.dataset.index);
            const opening = answer.classList.contains('hidden');
            answer.classList.toggle('hidden', !opening);
            btn.textContent = opening ? 'Çözümü gizle' : 'Çözümü göster';
            if (opening && !answer.dataset.rendered) { renderMath(answer); answer.dataset.rendered = '1'; }
        });
    });
}
async function loadArchive() {
    const archiveList = $('archive-list'); archiveList.innerHTML = '<div class="glass-card">Yükleniyor...</div>';
    try {
        const response = await fetch('/history'); archiveData = await response.json();
        archiveFilter = 'Hepsi'; renderArchiveFilter(); renderArchiveList();
    } catch { archiveList.innerHTML = '<div class="glass-card" style="color:var(--coral);">Arşiv yüklenemedi.</div>'; }
}

// ---------- 4) PDF SINAVI ----------
const countInput = $('pdf-count');
function clampCount(v) { const n = parseInt(v, 10); return isNaN(n) ? 10 : Math.min(50, Math.max(1, n)); }
$('count-minus').addEventListener('click', () => { countInput.value = clampCount(clampCount(countInput.value) - 1); });
$('count-plus').addEventListener('click', () => { countInput.value = clampCount(clampCount(countInput.value) + 1); });
countInput.addEventListener('change', () => { countInput.value = clampCount(countInput.value); });

$('generate-pdf-btn').addEventListener('click', async () => {
    const btn = $('generate-pdf-btn'); const resetBtn = () => { btn.textContent = 'PDF İndir 📥'; btn.disabled = false; };
    btn.textContent = 'Hazırlanıyor... ⏳'; btn.disabled = true;
    const selectedSubjects = Array.from(document.querySelectorAll('#pdf-subjects input:checked')).map((cb) => cb.value);
    const count = clampCount(countInput.value);
    if (selectedSubjects.length === 0) { showToast('En az bir ders seçmelisin.'); resetBtn(); return; }
    let pdfContainer;
    try {
        const response = await fetch('/history'); const allQuestions = await response.json();
        let filtered = allQuestions.filter((q) => selectedSubjects.includes(q.subject));
        if (filtered.length === 0) { showToast('Seçtiğin derslerde arşivde soru yok.'); resetBtn(); return; }
        filtered = filtered.sort(() => 0.5 - Math.random()).slice(0, count);
        pdfContainer = document.createElement('div');
        pdfContainer.style.cssText = 'width:800px;padding:40px;background:white;color:black;font-family:Inter,sans-serif;position:fixed;top:0;left:0;z-index:-1;';
        let questionsHtml = `<div class="pdf-header"><h1 style="font-size:24px;margin:0;">YKS Sorumatik</h1><p style="margin:5px 0 0 0;font-size:14px;">Kişiselleştirilmiş Deneme Testi</p></div><h3 style="margin-bottom:20px;">SORULAR</h3>`;
        let answersHtml = `<div class="pdf-answers"><h3 style="margin-bottom:20px;border-top:2px solid #000;padding-top:20px;">ÇÖZÜMLER VE TAKTİKLER</h3>`;
        filtered.forEach((q, index) => {
            questionsHtml += `<div class="pdf-question"><strong style="font-size:16px;">Soru ${index + 1} (${escapeHtml(q.subject)})</strong><br><img src="data:image/jpeg;base64,${q.image}"></div>`;
            answersHtml += `<div class="pdf-answer-item"><strong style="font-size:16px;color:#1e3a8a;">Soru ${index + 1} Çözümü</strong><br><div style="font-size:14px;line-height:1.6;margin-top:10px;">${marked.parse(q.answer)}</div></div>`;
        });
        answersHtml += '</div>';
        pdfContainer.innerHTML = questionsHtml + answersHtml;
        document.body.appendChild(pdfContainer); renderMath(pdfContainer);
        const opt = { margin: 10, filename: `YKS_Sorumatik_Test_${Date.now()}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        await html2pdf().set(opt).from(pdfContainer).save(); showToast('PDF indirildi. Bol şans! 💪');
    } catch (error) { console.error(error); showToast('PDF oluşturulurken bir hata oluştu.'); }
    finally { if (pdfContainer && pdfContainer.parentNode) pdfContainer.parentNode.removeChild(pdfContainer); resetBtn(); }
});

// ---------- 5) PREMIUM ----------
document.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        const originalText = btn.textContent; btn.textContent = 'İşleniyor...'; btn.disabled = true;
        try {
            const res = await fetch('/api/subscribe', { method: 'POST' });
            if (res.ok) { showToast("Ödeme başarılı! Artık sınırsız üyesin. 🎉"); await fetchStatus(); switchTab('home'); }
            else { showToast("Ödeme sırasında bir hata oluştu."); }
        } catch (e) { showToast("Bağlantı hatası."); }
        finally { btn.textContent = originalText; btn.disabled = false; }
    });
});

// ---------- Başlangıç ----------
fetchStatus(); renderStats(); drawPomo(); updateSendState(); updateCoachSend();
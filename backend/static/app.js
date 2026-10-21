'use strict';
// ============================================================
// YKS Sorumatik - Arayüz Mantığı
// ============================================================
const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const e = $(id); if (e) e.textContent = v; };

const ABI_AVATAR = `<div class="msg-avatar" style="background:var(--neon-blue);font-size:20px;">🧠</div>`;
const COACH_AVATAR = `<div class="msg-avatar" style="background:var(--neon-green);font-size:20px;">🧑‍🏫</div>`;

const MATH_OPTIONS = {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
    throwOnError: false,
};

const SUBJECT_DATA = {
    TYT: ['TYT Matematik', 'TYT Türkçe', 'TYT Fen', 'TYT Sosyal'],
    AYT: ['AYT Matematik', 'AYT Edebiyat', 'AYT Fen', 'AYT Sosyal'],
};
const ALL_SUBJECTS = [...SUBJECT_DATA.TYT, ...SUBJECT_DATA.AYT];

// ---------- Yardımcılar ----------
const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { } },
};
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nl2br(str) { return escapeHtml(str).replace(/\n/g, '<br>'); }
function todayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

let toastTimer;
function showToast(message) {
    const el = $('toast'); el.textContent = message; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
function renderMath(el) { if (typeof renderMathInElement === 'function') renderMathInElement(el, MATH_OPTIONS); }
function scrollEnd(container) { if (container) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; }); }
const isDesktop = window.matchMedia('(pointer: fine)').matches;

function renderMarkdown(text) {
    const maths = [];
    const t = String(text).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => { maths.push(m); return `@@M${maths.length - 1}@@`; });
    let html = window.marked ? marked.parse(t, { breaks: true }) : nl2br(t);
    html = html.replace(/@@M(\d+)@@/g, (_, i) => escapeHtml(maths[Number(i)]));
    return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}

async function postJson(url, body) {
    let response;
    try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } 
    catch { throw new Error('Bağlantı kurulamadı.'); }
    let data = {}; try { data = await response.json(); } catch { }
    if (!response.ok || !data.answer) {
        const msg = [data.error, data.detail].find((m) => typeof m === 'string');
        const err = new Error(msg || 'Şu an cevap hazırlanamadı.'); err.status = response.status; throw err;
    }
    return data;
}

function compressImage(file, maxSide = 1600, quality = 0.85) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const s = Math.min(1, maxSide / Math.max(img.width, img.height));
            const w = Math.round(img.width * s), h = Math.round(img.height * s);
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(url);
            c.toBlob((b) => resolve(b || file), 'image/jpeg', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
    });
}

// ---------- KULLANICI DURUMU ----------
let userStatus = { is_premium: false, remaining: 3 };

function applyStatus(data) {
    if (!data) return;
    if (typeof data.is_premium === 'boolean') userStatus.is_premium = data.is_premium;
    if (typeof data.remaining === 'number') userStatus.remaining = data.remaining;
    if ('plan' in data) userStatus.plan = data.plan;
    if ('premium_until' in data) userStatus.premium_until = data.premium_until;
    updateQuotaUI(); updatePremiumUI();
}
async function fetchStatus() {
    try { const res = await fetch('/api/status'); if (res.ok) applyStatus(await res.json()); } catch (e) {}
}
function updateQuotaUI() {
    const text = $('quota-text'); if (!text) return;
    if (userStatus.is_premium) { text.textContent = 'Sınırsız 💎'; text.style.color = 'var(--neon-blue)'; } 
    else {
        text.innerHTML = `Kalan Hak: <strong>${userStatus.remaining}</strong>`;
        text.style.color = userStatus.remaining === 0 ? 'var(--coral)' : 'var(--accent)';
    }
}
const PLAN_NAMES = { weekly: 'Haftalık', monthly: 'Aylık', yearly: 'Yıllık' };
function updatePremiumUI() {
    const lock = $('pdf-lock'); if (lock) lock.classList.toggle('hidden', !!userStatus.is_premium);
    const box = $('premium-status'); if (!box) return;
    if (userStatus.is_premium && userStatus.premium_until) {
        const d = new Date(userStatus.premium_until * 1000).toLocaleDateString('tr-TR');
        box.textContent = `✅ ${PLAN_NAMES[userStatus.plan] || 'Premium'} üyelik aktif — bitiş: ${d}`;
        box.classList.remove('hidden');
    } else box.classList.add('hidden');
}
function openPremiumModal() { $('premium-modal').classList.remove('hidden'); }
function closePremiumModal() { $('premium-modal').classList.add('hidden'); }
$('modal-close').addEventListener('click', closePremiumModal);
$('modal-go-premium').addEventListener('click', () => { closePremiumModal(); switchTab('premium'); });
$('quota-chip').addEventListener('click', () => switchTab('premium'));

// ---------- MESAJ BALONLARI ----------
function messageHtml({ role, body, cls = '', avatar = ABI_AVATAR }) {
    if (role === 'user') return `<div class="message user ${cls}"><div class="msg-bubble">${body}</div></div>`;
    return `<div class="message ai ${cls}">${avatar}<div class="msg-bubble">${body}</div></div>`;
}
function addMessage(container, opts) {
    container.insertAdjacentHTML('beforeend', messageHtml(opts));
    const el = container.lastElementChild; scrollEnd(container); return el;
}
function addTyping(container, avatar) {
    return addMessage(container, { role: 'ai', avatar, body: '<div class="typing-indicator"><span></span><span></span><span></span></div>' });
}
function addAiMarkdown(container, text, avatar) {
    const el = addMessage(container, { role: 'ai', avatar, body: '' });
    const bubble = el.querySelector('.msg-bubble');
    bubble.innerHTML = renderMarkdown(text); renderMath(bubble); scrollEnd(container); return el;
}
function addQuickReplies(container, items) {
    const row = document.createElement('div'); row.className = 'quick-replies';
    items.forEach((item) => {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = item.label;
        btn.addEventListener('click', () => { row.remove(); item.action(); });
        row.appendChild(btn);
    });
    container.appendChild(row); scrollEnd(container);
}

// ---------- SAYAÇLAR ----------
function dayCounter(key) {
    return {
        get() { const v = store.get(key, { date: null, count: 0 }); return v.date === todayKey() ? v.count : 0; },
        bump(n = 1) { store.set(key, { date: todayKey(), count: this.get() + n }); },
    };
}
const doneCounter = dayCounter('yks_done');
const pomoCounter = dayCounter('yks_pomo');
const focusCounter = dayCounter('yks_focus');

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
    const target = new Date(y, m - 1, d); const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((target - now) / 86400000));
}
function getProfile() {
    const mood = store.get('yks_mood', {});
    return {
        name: store.get('yks_name', ''), examDate: store.get('yks_exam', ''), daysLeft: daysLeft(),
        streak: getStreak(), dailyGoal: getGoal(), doneToday: doneCounter.get(),
        pomodorosToday: pomoCounter.get(), focusMinutesToday: focusCounter.get(),
        totalSolved: store.get('yks_total', 0), mood: mood.date === todayKey() ? mood.key : '',
    };
}

// ---------- SEKME GEÇİŞLERİ ----------
function switchTab(tabId) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    $('view-' + tabId).classList.add('active');
    const nav = document.querySelector(`.nav-item[data-tab="${tabId}"]`); if (nav) nav.classList.add('active');
    if (tabId === 'archive') { loadArchive(); updatePremiumUI(); }
    if (tabId === 'panel') renderStats();
    if (tabId === 'solve') scrollEnd($('chat-history'));
    if (tabId === 'coach') scrollEnd($('coach-messages'));
    if (tabId === 'premium') { fetchStatus(); }
}
document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ---------- 1) PANELİM ----------
function renderStats() {
    const goal = getGoal(), done = doneCounter.get();
    const percent = Math.min(100, Math.round((done / goal) * 100));
    const circle = $('goal-circle');
    if (circle) {
        const c = 2 * Math.PI * 40;
        circle.style.strokeDasharray = `${c}`;
        circle.style.strokeDashoffset = c - (percent / 100) * c;
    }
    setText('goal-percent', `${percent}%`);
    setText('stat-streak', getStreak());
    setText('stat-goal', `${Math.min(done, 99)}/${goal}`);
    const left = daysLeft(); setText('stat-exam', left === null ? '–' : left);
    setText('stat-total', store.get('yks_total', 0));
    setText('stat-focus', focusCounter.get());
    setText('pomo-count', `Bugün ${pomoCounter.get()} tur`);
    setText('greeting-text', greeting());
    const exam = $('exam-date'); if (exam && document.activeElement !== exam) exam.value = store.get('yks_exam', '');
    const nameIn = $('name-input'); if (nameIn && document.activeElement !== nameIn) nameIn.value = store.get('yks_name', '');
    const mood = store.get('yks_mood', {});
    document.querySelectorAll('.mood-btn').forEach((b) => b.classList.toggle('active', mood.date === todayKey() && mood.key === b.dataset.mood));
}
function greeting() {
    const h = new Date().getHours();
    const part = h < 6 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
    const name = store.get('yks_name', '');
    return name ? `${part}, ${name}! 👋` : `${part}! 👋`;
}
$('goal-minus').addEventListener('click', () => { store.set('yks_goal', Math.max(1, getGoal() - 1)); renderStats(); });
$('goal-plus').addEventListener('click', () => { store.set('yks_goal', Math.min(50, getGoal() + 1)); renderStats(); });
$('exam-date').addEventListener('change', (e) => { store.set('yks_exam', e.target.value); renderStats(); });
$('name-input').addEventListener('change', (e) => { store.set('yks_name', e.target.value.trim().slice(0, 20)); renderStats(); });

const MOOD_FALLBACK = {
    'yorgun': 'Yorgun hissetmen normal. Hedefi küçült: 2-3 soru çöz, sonra dinlen.',
    'kaygılı': 'Kaygı, önemsediğin için var. Derin bir nefes al, sadece bugüne odaklan.',
    'iyi': 'Güzel! Bu enerjiyle en zorlandığın konudan bir soru çöz.',
    'çok motive': 'Enerjin süper! 🚀 Hemen bir odak turu başlat.',
};
$('mood-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mood-btn'); if (!btn) return;
    const key = btn.dataset.mood; store.set('yks_mood', { date: todayKey(), key });
    document.querySelectorAll('.mood-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const note = $('coach-note'); note.classList.remove('hidden'); note.textContent = 'Koç yazıyor...';
    try {
        const data = await postJson('/coach', { message: `Bugün ruh halim: ${key}. Bana 2-3 cümlelik, samimi ve uygulanabilir bir motivasyon mesajı yaz.`, history: [], profile: getProfile() });
        note.innerHTML = renderMarkdown(data.answer);
    } catch { note.textContent = MOOD_FALLBACK[key] || ''; }
});

// ---------- 2) SORU ÇÖZ ----------
const cameraInput = $('camera-input'), galleryInput = $('gallery-input');
const solveBtn = $('solve-btn'), messageInput = $('message-input'), chatHistory = $('chat-history');
let selectedFile = null, selectedPreviewUrl = null, selectedSubject = 'TYT Matematik', sending = false;
let thread = { subject: 'TYT Matematik', note: '', solution: null, history: [] };

function updateSendState() { solveBtn.disabled = sending || (!selectedFile && messageInput.value.trim() === ''); }
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

function renderSubjects(cat) {
    const container = $('subject-chips');
    container.innerHTML = SUBJECT_DATA[cat].map((sub, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-value="${escapeHtml(sub)}">${escapeHtml(sub)}</button>`).join('');
    selectedSubject = SUBJECT_DATA[cat][0];
    container.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
        container.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active'); selectedSubject = c.dataset.value;
    }));
}
document.querySelectorAll('.cat-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active'); renderSubjects(btn.dataset.cat);
}));
renderSubjects('TYT');

async function handleFile(file, inputEl) {
    if (!file || !file.type.startsWith('image/')) { showToast('Lütfen bir fotoğraf seç.'); return; }
    const blob = await compressImage(file);
    selectedFile = blob; selectedPreviewUrl = URL.createObjectURL(blob);
    $('preview-img').src = selectedPreviewUrl; $('image-preview').classList.remove('hidden');
    messageInput.placeholder = 'İstersen soruyla ilgili not yaz, sonra gönder...';
    updateSendState(); if (inputEl) inputEl.value = ''; scrollEnd(chatHistory);
}
cameraInput.addEventListener('change', (e) => handleFile(e.target.files[0], cameraInput));
galleryInput.addEventListener('change', (e) => handleFile(e.target.files[0], galleryInput));
$('preview-remove').addEventListener('click', clearImage);

messageInput.addEventListener('input', () => { autoGrow(messageInput); updateSendState(); });
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && isDesktop) { e.preventDefault(); if (!solveBtn.disabled) sendMessage(); }
});
solveBtn.addEventListener('click', sendMessage);

function setSending(state) {
    sending = state; messageInput.disabled = state; updateSendState();
    if (!state && isDesktop) messageInput.focus();
}
function clearTransient() { chatHistory.querySelectorAll('.feedback-row,.quick-replies').forEach((n) => n.remove()); }

async function sendMessage() {
    if (sending) return;
    const text = messageInput.value.trim(); if (!selectedFile && !text) return;
    if (!userStatus.is_premium && userStatus.remaining <= 0) {
        showToast('Günlük soru hakkın doldu. Sınırsız çözüm için Premium\'a geç.'); switchTab('premium'); return;
    }
    clearTransient();
    if (selectedFile) await solveImage(text); else await askFollowup(text);
}

function handleLimit(err) { showToast('Günlük hakkın doldu.'); switchTab('premium'); }

async function solveImage(note) {
    const fileToSend = selectedFile, previewUrl = selectedPreviewUrl, subject = selectedSubject;
    addMessage(chatHistory, { role: 'user', body: `<img class="chat-img" src="${previewUrl}" alt="Soru">${note ? `<div>${nl2br(note)}</div>` : ''}` });
    messageInput.value = ''; autoGrow(messageInput); clearImage(); setSending(true); touchStreak();

    const typing = addTyping(chatHistory, ABI_AVATAR);
    const formData = new FormData();
    formData.append('file', fileToSend, 'soru.jpg'); formData.append('subject', subject); formData.append('note', note);
    try {
        const response = await fetch('/solve', { method: 'POST', body: formData });
        const data = await response.json().catch(() => ({}));
        typing.remove();
        if (!response.ok || !data.answer) {
            const msg = [data.error, data.detail].find((m) => typeof m === 'string') || 'Çözüm hazırlanamadı.';
            if (response.status === 403) handleLimit();
            addMessage(chatHistory, { role: 'ai', body: escapeHtml(msg), cls: 'error' });
        } else {
            thread = { subject, note, solution: data.answer, history: [] };
            addAiMarkdown(chatHistory, data.answer); addFeedbackRow(); applyStatus(data);
        }
    } catch {
        typing.remove(); addMessage(chatHistory, { role: 'ai', body: 'Bağlantı kurulamadı.', cls: 'error' });
    } finally { setSending(false); scrollEnd(chatHistory); }
}

async function askFollowup(text) {
    if (!thread.solution) thread.subject = selectedSubject;
    addMessage(chatHistory, { role: 'user', body: nl2br(text) });
    messageInput.value = ''; autoGrow(messageInput); setSending(true);

    const typing = addTyping(chatHistory, ABI_AVATAR);
    try {
        const data = await postJson('/followup', { subject: thread.subject, note: thread.note, solution: thread.solution, history: thread.history.slice(-10), message: text });
        typing.remove(); thread.history.push({ role: 'user', content: text }, { role: 'assistant', content: data.answer });
        addAiMarkdown(chatHistory, data.answer); addFeedbackRow(); applyStatus(data);
    } catch (err) {
        typing.remove(); if (err.status === 403) handleLimit();
        addMessage(chatHistory, { role: 'ai', body: escapeHtml(err.message), cls: 'error' });
    } finally { setSending(false); scrollEnd(chatHistory); }
}

function addFeedbackRow() {
    const row = document.createElement('div'); row.className = 'feedback-row';
    row.innerHTML = `<span class="muted small">Anlatım net oldu mu?</span>
        <button type="button" class="yes">✅ Anlaşıldı</button>
        <button type="button" class="no">🤔 Anlaşılmadı</button>`;
    chatHistory.appendChild(row); scrollEnd(chatHistory);
    row.querySelector('.yes').addEventListener('click', () => { row.remove(); onUnderstood(); });
    row.querySelector('.no').addEventListener('click', () => { row.remove(); onNotUnderstood(); });
}

const PRAISE = ['Harika! Bu soru artık senin. 💪', 'Süper! Netlerin artıyor. 🎉', 'Tamamdır, bir soruyu daha hallettik! 🚀'];
function onUnderstood() {
    addMessage(chatHistory, { role: 'user', body: 'Anlaşıldı ✅' });
    doneCounter.bump(); store.set('yks_total', store.get('yks_total', 0) + 1); touchStreak(); renderStats();
    const goal = getGoal(), done = doneCounter.get();
    let extra = `Bugün ${done} soruyu anlayarak çözdün.`;
    if (done === goal) extra = '🎯 Günlük hedefini tamamladın, tebrikler!';
    else if (done < goal) extra += ` Hedefe ${goal - done} soru kaldı.`;
    addMessage(chatHistory, { role: 'ai', body: `${PRAISE[Math.floor(Math.random() * PRAISE.length)]}<br><br>${escapeHtml(extra)}` });
    addQuickReplies(chatHistory, [
        { label: '🔁 Benzer soru ver', action: () => quickSend('Buna benzer, biraz daha zor bir soru ver.') },
        { label: '📷 Yeni soru ekle', action: () => cameraInput.click() },
    ]);
}
function onNotUnderstood() {
    addMessage(chatHistory, { role: 'user', body: 'Anlaşılmadı 🤔' });
    addMessage(chatHistory, { role: 'ai', body: 'Sorun değil, birlikte netleştirelim. 💪<br>Hangi kısımda takıldın?' });
    addQuickReplies(chatHistory, [
        { label: 'Daha basit anlat', action: () => quickSend('Bunu daha basit ve kısa cümlelerle anlat.') },
        { label: 'Başka yoldan çöz', action: () => quickSend('Bu soruyu başka bir yöntemle çöz.') },
    ]);
    messageInput.focus();
}
function quickSend(text) { messageInput.value = text; updateSendState(); sendMessage(); }

function clearImage() {
    selectedFile = null; selectedPreviewUrl = null;
    cameraInput.value = ''; galleryInput.value = '';
    $('image-preview').classList.add('hidden'); $('preview-img').removeAttribute('src');
    messageInput.placeholder = 'Takıldığın yeri yaz...'; updateSendState();
}

addMessage(chatHistory, { role: 'ai', body: 'Merhaba! 👋 Bir soru fotoğrafı yükle ya da takıldığın yeri yaz, adım adım çözelim.' });

// ---------- 3) KOÇ ----------
const coachMessages = $('coach-messages'), coachInput = $('coach-input'), coachSend = $('coach-send');
let coachHistory = [], coachSending = false;

function enterCoachChat() { $('view-coach').classList.add('chatting'); }
function exitCoachChat() { $('view-coach').classList.remove('chatting'); }
$('coach-back').addEventListener('click', exitCoachChat);

function updateCoachSend() { coachSend.disabled = coachSending || coachInput.value.trim() === ''; }
coachInput.addEventListener('input', () => { autoGrow(coachInput); updateCoachSend(); });
coachInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && isDesktop) { e.preventDefault(); if (!coachSend.disabled) sendCoach(coachInput.value.trim()); }
});
coachSend.addEventListener('click', () => sendCoach(coachInput.value.trim()));
document.querySelectorAll('.quick-btn').forEach((btn) => btn.addEventListener('click', () => sendCoach(btn.dataset.prompt)));

async function sendCoach(text) {
    if (!text || coachSending) return;
    enterCoachChat();
    addMessage(coachMessages, { role: 'user', body: nl2br(text) });
    coachInput.value = ''; autoGrow(coachInput); coachSending = true; updateCoachSend();

    const typing = addTyping(coachMessages, COACH_AVATAR);
    try {
        const data = await postJson('/coach', { message: text, history: coachHistory.slice(-12), profile: getProfile() });
        typing.remove(); coachHistory.push({ role: 'user', content: text }, { role: 'assistant', content: data.answer });
        addAiMarkdown(coachMessages, data.answer, COACH_AVATAR);
    } catch (err) {
        typing.remove(); addMessage(coachMessages, { role: 'ai', avatar: COACH_AVATAR, body: escapeHtml(err.message), cls: 'error' });
    } finally { coachSending = false; updateCoachSend(); scrollEnd(coachMessages); }
}

// ---------- 4) ODAKLAN ----------
const pomo = { total: 25 * 60, remaining: 25 * 60, running: false, endAt: 0, timer: null, wake: null };

function fmt(sec) { return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
function drawPomo() {
    const t = fmt(pomo.remaining);
    setText('pomo-time', t); setText('pomo-full-time', t);
    const label = pomo.running ? 'Duraklat' : (pomo.remaining < pomo.total ? 'Devam et' : 'Başlat');
    setText('pomo-toggle', label); setText('pomo-full-toggle', label);
    $('pomo-bar').style.width = `${((pomo.total - pomo.remaining) / pomo.total) * 100}%`;
    document.title = pomo.running ? `${t} · YKS Sorumatik` : 'YKS Sorumatik';
}
async function lockWake() { try { if (navigator.wakeLock) pomo.wake = await navigator.wakeLock.request('screen'); } catch { } }
function unlockWake() { try { if (pomo.wake) { pomo.wake.release(); pomo.wake = null; } } catch { } }

function openPomoFull() {
    $('pomo-full').classList.remove('hidden');
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => { });
}
function closePomoFull() {
    $('pomo-full').classList.add('hidden');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => { });
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('pomo-full').classList.add('hidden'); });

function resetPomo() { clearInterval(pomo.timer); pomo.running = false; pomo.remaining = pomo.total; unlockWake(); drawPomo(); }
function pomoTick() {
    pomo.remaining = Math.max(0, Math.round((pomo.endAt - Date.now()) / 1000));
    if (pomo.remaining === 0) {
        const minutes = Math.round(pomo.total / 60);
        pomoCounter.bump(); focusCounter.bump(minutes);
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        closePomoFull(); resetPomo(); renderStats(); showToast('Tur tamam! 🎉 Mola zamanı.');
        return;
    }
    drawPomo();
}
function togglePomo() {
    if (pomo.running) {
        clearInterval(pomo.timer); pomo.running = false; unlockWake();
    } else {
        pomo.running = true; pomo.endAt = Date.now() + pomo.remaining * 1000;
        pomo.timer = setInterval(pomoTick, 250); lockWake(); openPomoFull();
    }
    drawPomo();
}
document.addEventListener('visibilitychange', () => { if (pomo.running && document.visibilityState === 'visible') { lockWake(); pomoTick(); } });
$('pomo-toggle').addEventListener('click', togglePomo);
$('pomo-full-toggle').addEventListener('click', togglePomo);
$('pomo-full-close').addEventListener('click', closePomoFull);
$('pomo-expand').addEventListener('click', openPomoFull);
$('pomo-reset').addEventListener('click', resetPomo);
document.querySelectorAll('.dur-chip').forEach((c) => c.addEventListener('click', () => {
    if (pomo.running) { showToast('Önce sayacı duraklat veya sıfırla.'); return; }
    document.querySelectorAll('.dur-chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active'); pomo.total = Number(c.dataset.min) * 60; pomo.remaining = pomo.total; drawPomo();
}));

// ---------- 5) ARŞİV ----------
let archiveData = [], archiveFilter = 'Hepsi';
function renderArchiveFilter() {
    const names = ['Hepsi', ...ALL_SUBJECTS.filter((s) => archiveData.some((q) => q.subject === s))];
    $('archive-filter').innerHTML = names.map((n) => `<button type="button" class="chip ${n === archiveFilter ? 'active' : ''}" data-filter="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
}
$('archive-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    archiveFilter = chip.dataset.filter; renderArchiveFilter(); renderArchiveList();
});
function renderArchiveList() {
    const list = $('archive-list');
    const items = archiveFilter === 'Hepsi' ? archiveData : archiveData.filter((q) => q.subject === archiveFilter);
    if (items.length === 0) { list.innerHTML = `<div class="glass-card muted" style="text-align:center">📭 Burada henüz soru yok.</div>`; return; }
    list.innerHTML = items.map((item, i) => {
        const date = new Date(item.created_at).toLocaleDateString('tr-TR');
        return `<div class="glass-card" style="margin-bottom:14px">
            <img class="arch-img" src="data:image/jpeg;base64,${item.image}" alt="Soru">
            <div class="arch-meta"><span class="arch-tag">${escapeHtml(item.subject)}</span><span class="small muted">${date}</span></div>
            <button type="button" class="ghost-btn full archive-toggle" data-index="${i}">Çözümü göster</button>
            <div class="archive-answer hidden" id="answer-${i}">${renderMarkdown(item.answer)}</div>
        </div>`;
    }).join('');
    list.querySelectorAll('.archive-toggle').forEach((btn) => btn.addEventListener('click', () => {
        const answer = $('answer-' + btn.dataset.index);
        const opening = answer.classList.contains('hidden');
        answer.classList.toggle('hidden', !opening);
        btn.textContent = opening ? 'Çözümü gizle' : 'Çözümü göster';
        if (opening && !answer.dataset.rendered) { renderMath(answer); answer.dataset.rendered = '1'; }
    }));
}
async function loadArchive() {
    const list = $('archive-list'); list.innerHTML = '<div class="glass-card muted">Yükleniyor...</div>';
    try {
        const response = await fetch('/history'); if (!response.ok) throw new Error();
        archiveData = await response.json(); archiveFilter = 'Hepsi'; renderArchiveFilter(); renderArchiveList();
    } catch { list.innerHTML = '<div class="glass-card" style="color:var(--coral)">Arşiv yüklenemedi.</div>'; }
}

// ---------- 6) PDF (Premium) ----------
$('pdf-subjects').innerHTML = ALL_SUBJECTS.map((s) => `<label><input type="checkbox" value="${escapeHtml(s)}" checked> ${escapeHtml(s)}</label>`).join('');
const countInput = $('pdf-count');
function clampCount(v) { const n = parseInt(v, 10); return isNaN(n) ? 10 : Math.min(50, Math.max(1, n)); }
$('count-minus').addEventListener('click', () => { countInput.value = clampCount(clampCount(countInput.value) - 1); });
$('count-plus').addEventListener('click', () => { countInput.value = clampCount(clampCount(countInput.value) + 1); });
countInput.addEventListener('change', () => { countInput.value = clampCount(countInput.value); });

$('generate-pdf-btn').addEventListener('click', async () => {
    if (!userStatus.is_premium) { openPremiumModal(); return; }
    const btn = $('generate-pdf-btn');
    const resetBtn = () => { btn.textContent = 'PDF İndir 📥'; btn.disabled = false; };
    const selectedSubjects = Array.from(document.querySelectorAll('#pdf-subjects input:checked')).map((cb) => cb.value);
    const count = clampCount(countInput.value);
    if (selectedSubjects.length === 0) { showToast('En az bir ders seçmelisin.'); return; }

    btn.textContent = 'Hazırlanıyor... ⏳'; btn.disabled = true;
    let pdfContainer;
    try {
        const response = await fetch('/history?pdf=1');
        if (response.status === 403) { openPremiumModal(); fetchStatus(); return; }
        if (!response.ok) throw new Error('history');
        const all = await response.json();
        let filtered = all.filter((q) => selectedSubjects.includes(q.subject));
        if (filtered.length === 0) { showToast('Seçtiğin derslerde arşivde soru yok.'); return; }
        filtered = filtered.sort(() => 0.5 - Math.random()).slice(0, count);

        // HATA DÜZELTİLDİ: z-index ve görünürlük ayarlandı.
        pdfContainer = document.createElement('div');
        pdfContainer.style.cssText = 'width:794px;padding:40px;background:#fff;color:#000;font-family:Inter,Arial,sans-serif;position:fixed;top:0;left:0;z-index:9999;opacity:0;pointer-events:none;';
        let html = `<div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #000;padding-bottom:10px"><h1 style="margin:0">YKS Sorumatik</h1><p>Kişiselleştirilmiş Deneme Testi</p></div><h3>SORULAR</h3>`;
        filtered.forEach((q, i) => {
            html += `<div style="margin-bottom:30px;page-break-inside:avoid"><strong>Soru ${i + 1} (${escapeHtml(q.subject)})</strong><br><img src="data:image/jpeg;base64,${q.image}" style="max-width:100%;max-height:400px;display:block;margin:10px 0"></div>`;
        });
        html += `<div style="page-break-before:always"><h3 style="border-top:2px solid #000;padding-top:20px">ÇÖZÜMLER</h3>`;
        filtered.forEach((q, i) => {
            html += `<div style="margin-bottom:30px;page-break-inside:avoid"><strong>Soru ${i + 1} Çözümü</strong><div style="font-size:14px;line-height:1.6">${renderMarkdown(q.answer)}</div></div>`;
        });
        html += `</div>`;
        pdfContainer.innerHTML = html;
        document.body.appendChild(pdfContainer);
        renderMath(pdfContainer);

        await Promise.all(Array.from(pdfContainer.querySelectorAll('img')).map((img) => img.decode ? img.decode().catch(() => { }) : Promise.resolve()));
        await new Promise((r) => setTimeout(r, 500));

        const opt = {
            margin: 10, filename: `YKS_Test_${Date.now()}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'] },
        };
        await html2pdf().set(opt).from(pdfContainer).save();
        showToast('PDF indirildi. Bol şans! 💪');
    } catch (error) {
        console.error(error); showToast('PDF oluşturulurken bir hata oluştu.');
    } finally {
        if (pdfContainer && pdfContainer.parentNode) pdfContainer.parentNode.removeChild(pdfContainer);
        resetBtn();
    }
});

// ---------- 7) PREMIUM ----------
document.querySelectorAll('.buy-btn').forEach((btn) => btn.addEventListener('click', async () => {
    const originalText = btn.textContent; btn.textContent = 'İşleniyor...'; btn.disabled = true;
    try {
        const res = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: btn.dataset.plan }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { showToast('Ödeme başarılı! Artık sınırsız üyesin. 🎉'); applyStatus(data); await fetchStatus(); switchTab('panel'); }
        else showToast(data.error || 'Ödeme sırasında bir hata oluştu.');
    } catch { showToast('Bağlantı hatası.'); }
    finally { btn.textContent = originalText; btn.disabled = false; }
}));

// ---------- Başlangıç ----------
fetchStatus();
renderStats();
drawPomo();
updateSendState();
updateCoachSend();
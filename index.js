/**
 * Study Planner (beta) — SillyTavern extension
 *
 * - Study timer with a dark "focus mode" (character avatar + timer only)
 * - Sessions log, daily/weekly stats, streak, D-day
 * - Plans with free date ranges (day / week / month / anything), editable
 * - Plans can be extracted from the current chat with the connected model
 * - A short, reference-only summary is injected into the prompt so the
 *   character can react to your record in its own voice. The extension itself
 *   never defines a personality.
 *
 * All data is stored globally in extensionSettings (not per character / chat).
 */

const MODULE = 'study_planner';
const PROMPT_KEY = 'study_planner';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULTS = Object.freeze({
    enabled: true,
    inject: true,
    injectDepth: 1,
    autoFocus: true,
    showSeconds: false,
    showPill: true,
    dayStartHour: 4,
    streakMinMinutes: 30,
    accent: '#8aa4ff',
    focusImage: '',
    ddayName: '',
    ddayDate: '',
    subjects: ['공부'],
    lastSubject: '공부',
    running: null, // { start:number, subject:string }
    sessions: [], // { id, start, end, subject }
    plans: [], // { id, title, start:'YYYY-MM-DD', end:'YYYY-MM-DD', parentId, items:[{id,text,done}] }
});

/* ------------------------------------------------------------------ */
/* Core helpers                                                        */
/* ------------------------------------------------------------------ */

const ctx = () => SillyTavern.getContext();

function S() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(DEFAULTS);
    }
    const cur = extensionSettings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(cur, key)) cur[key] = structuredClone(DEFAULTS[key]);
    }
    return cur;
}

const commit = () => ctx().saveSettingsDebounced();

/** Surface errors on screen: on mobile there is no console to look at. */
function reportError(e) {
    console.error(`[${MODULE}]`, e);
    try {
        toastr.error(`Study Planner 오류: ${e?.message || e}`);
    } catch (_) {
        /* ignore */
    }
}

/**
 * Make an overlay visible even if style.css failed to load or is blocked:
 * layout is forced inline, and a plain fallback look is applied when the stylesheet is missing.
 */
let warnedCss = false;
function guardOverlay(el, z, bg) {
    el.style.setProperty('position', 'fixed');
    el.style.setProperty('inset', '0');
    el.style.setProperty('z-index', String(z));
    if (!getComputedStyle(el).getPropertyValue('--sp-radius').trim()) {
        el.style.setProperty('background', bg);
        el.style.setProperty('color', '#eee');
        el.style.setProperty('overflow', 'auto');
        if (!warnedCss) {
            warnedCss = true;
            toastr.warning('Study Planner: style.css를 불러오지 못했어요. 확장을 업데이트하거나 다시 설치해 주세요');
        }
    }
}
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const pad = (n) => String(n).padStart(2, '0');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FA = (name, extra = '') => `<i class="fa-solid fa-${name} ${extra}"></i>`;

/* ---- dates: a "study day" starts at dayStartHour (default 04:00) ---- */

const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => {
    const [y, m, d] = String(k).split('-').map(Number);
    return new Date(y, m - 1, d);
};
const addDays = (k, n) => {
    const d = parseKey(k);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
};
const dayKey = (ts) => fmtDate(new Date(ts - S().dayStartHour * HOUR));
const dayStartTs = (k) => parseKey(k).getTime() + S().dayStartHour * HOUR;
const mdLabel = (k) => {
    const d = parseKey(k);
    return `${d.getMonth() + 1}/${d.getDate()}`;
};
const wdLabel = (k) => WEEKDAYS[parseKey(k).getDay()];
const rangeLabel = (a, b) => (a === b ? mdLabel(a) : `${mdLabel(a)}~${mdLabel(b)}`);
const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function relLabel(k) {
    const today = dayKey(Date.now());
    if (k === today) return '오늘';
    if (k === addDays(today, 1)) return '내일';
    if (k === addDays(today, -1)) return '어제';
    return '';
}

/* ---- durations ---- */

function fmtDur(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return `${m}분`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
}

function fmtDurEn(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
}

function fmtClock(ms, secs) {
    ms = Math.max(0, ms);
    const h = Math.floor(ms / HOUR);
    const m = Math.floor(ms / MIN) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return secs ? `${h}:${pad(m)}:${pad(s)}` : `${h}:${pad(m)}`;
}

const clockOf = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ------------------------------------------------------------------ */
/* Data queries                                                        */
/* ------------------------------------------------------------------ */

function allSessions() {
    const s = S();
    if (!s.running) return s.sessions;
    return [...s.sessions, { id: 'running', start: s.running.start, end: Date.now(), subject: s.running.subject }];
}

function msOnDay(k, list = allSessions()) {
    const a = dayStartTs(k);
    const b = dayStartTs(addDays(k, 1));
    let total = 0;
    for (const x of list) {
        const overlap = Math.min(x.end, b) - Math.max(x.start, a);
        if (overlap > 0) total += overlap;
    }
    return total;
}

function subjectMs(k, list = allSessions()) {
    const a = dayStartTs(k);
    const b = dayStartTs(addDays(k, 1));
    const map = new Map();
    for (const x of list) {
        const overlap = Math.min(x.end, b) - Math.max(x.start, a);
        if (overlap > 0) map.set(x.subject, (map.get(x.subject) || 0) + overlap);
    }
    return map;
}

function streak() {
    const list = allSessions();
    const need = S().streakMinMinutes * MIN;
    let k = dayKey(Date.now());
    let n = 0;
    if (msOnDay(k, list) >= need) n++; // today counts once it qualifies, but never breaks the streak
    for (let i = 0; i < 400; i++) {
        k = addDays(k, -1);
        if (msOnDay(k, list) >= need) n++;
        else break;
    }
    return n;
}

function weekKeys() {
    const today = dayKey(Date.now());
    return Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
}

function ddayInfo() {
    const s = S();
    if (!isDateKey(s.ddayDate)) return null;
    const diff = Math.round((parseKey(s.ddayDate) - parseKey(dayKey(Date.now()))) / DAY);
    const label = diff === 0 ? 'D-Day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
    return { name: s.ddayName || 'D-day', label, diff };
}

const spanDays = (p) => (parseKey(p.end) - parseKey(p.start)) / DAY;
const plansOn = (k) => S().plans.filter((p) => p.start <= k && k <= p.end).sort((a, b) => spanDays(a) - spanDays(b));
const planCount = (p) => ({ total: p.items.length, done: p.items.filter((i) => i.done).length });

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function startSession(subject) {
    const s = S();
    if (s.running) return;
    subject = String(subject || s.lastSubject || s.subjects[0] || '공부').trim() || '공부';
    if (!s.subjects.includes(subject)) s.subjects.push(subject);
    s.lastSubject = subject;
    s.running = { start: Date.now(), subject };
    commit();
    refreshInjection();
    if (s.autoFocus) openFocus();
    scheduleTick();
    updatePill();
    renderModal();
}

async function stopSession() {
    const s = S();
    const r = s.running;
    if (!r) return;
    let end = Date.now();

    // Forgot to press stop? Ask for the real study time instead of recording a huge session.
    if (end - r.start > 8 * HOUR) {
        const { Popup } = ctx();
        const ans = await Popup.show.input(
            'Study Planner',
            `${fmtDur(end - r.start)} 동안 진행 중이었어요. 실제로 공부한 시간(분)을 입력해 주세요.`,
            '60',
        );
        if (!ans) return; // cancelled: keep running
        const m = parseInt(ans, 10);
        end = r.start + Math.max(1, Number.isFinite(m) ? m : 60) * MIN;
    }

    s.running = null;
    if (end - r.start >= MIN) {
        s.sessions.push({ id: uid(), start: r.start, end, subject: r.subject });
        toastr.success(`${fmtDur(end - r.start)} 공부했어요`);
    } else {
        toastr.info('1분 미만이라 기록하지 않았어요');
    }
    commit();
    closeFocus();
    refreshInjection();
    scheduleTick();
    updatePill();
    renderModal();
}

/* ------------------------------------------------------------------ */
/* Prompt injection (reference-only, English, no personality)          */
/* ------------------------------------------------------------------ */

function planLine(p) {
    const items = p.items.slice(0, 8).map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('; ');
    return `- "${p.title}" (${rangeLabel(p.start, p.end)})${items ? `: ${items}` : ''}`;
}

function buildInjection() {
    const s = S();
    const now = Date.now();
    const today = dayKey(now);
    const tomorrow = addDays(today, 1);
    const list = allSessions();
    const lines = [];

    const total = msOnDay(today, list);
    const by = [...subjectMs(today, list)].sort((a, b) => b[1] - a[1]);
    let first = `Today (${today}, ${WEEKDAYS_EN[parseKey(today).getDay()]}): studied ${fmtDurEn(total)}`;
    if (by.length) first += ` (${by.map(([k, v]) => `${k} ${fmtDurEn(v)}`).join(', ')})`;
    lines.push(first + '.');

    if (s.running) {
        lines.push(`The user is studying "${s.running.subject}" right now (${fmtDurEn(now - s.running.start)} so far).`);
    } else {
        lines.push('The user is not in a study session right now.');
    }

    const weekTotal = weekKeys().reduce((sum, k) => sum + msOnDay(k, list), 0);
    const st = streak();
    lines.push(`Last 7 days: ${fmtDurEn(weekTotal)} total. Study streak: ${st} day(s).`);

    const dd = ddayInfo();
    if (dd) lines.push(`Goal date: "${dd.name}" ${dd.label} (${S().ddayDate}).`);

    const todayPlans = plansOn(today).slice(0, 4);
    if (todayPlans.length) {
        lines.push("Today's plans:");
        todayPlans.forEach((p) => lines.push(planLine(p)));
    }
    const seen = new Set(todayPlans.map((p) => p.id));
    const tomorrowPlans = plansOn(tomorrow).filter((p) => !seen.has(p.id)).slice(0, 3);
    if (tomorrowPlans.length) {
        lines.push("Tomorrow's plans:");
        tomorrowPlans.forEach((p) => lines.push(planLine(p)));
    }

    const hasData = list.length || s.plans.length || dd || s.running;
    if (!hasData) return '';

    const head =
        "[Study Planner: background info about the user's study log. Treat it as reference only. " +
        'Mention or react to it only when it fits the conversation naturally (for example when the user talks about studying, plans, or progress). ' +
        'Never force the topic, and always stay fully in character.]';
    return `${head}\n${lines.join('\n')}`;
}

let warnedNoInject = false;
function refreshInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') {
        if (!warnedNoInject) {
            warnedNoInject = true;
            console.warn(`[${MODULE}] setExtensionPrompt is not available in this SillyTavern version; prompt injection is disabled.`);
        }
        return;
    }
    const s = S();
    const text = s.enabled && s.inject ? buildInjection() : '';
    const position = c.extension_prompt_types?.IN_CHAT ?? 1;
    const role = c.extension_prompt_roles?.SYSTEM ?? 0;
    c.setExtensionPrompt(PROMPT_KEY, text, position, Number(s.injectDepth) || 0, false, role);
}

/* ------------------------------------------------------------------ */
/* Chat helpers                                                        */
/* ------------------------------------------------------------------ */

function buildReport(extra) {
    const today = dayKey(Date.now());
    const total = msOnDay(today);
    const by = [...subjectMs(today)].sort((a, b) => b[1] - a[1]);
    const lines = [`[공부 기록 ${mdLabel(today)}(${wdLabel(today)})]`];
    if (total) {
        let l = `오늘 총 ${fmtDur(total)}`;
        if (by.length) l += ` — ${by.map(([k, v]) => `${k} ${fmtDur(v)}`).join(' · ')}`;
        lines.push(l);
    } else {
        lines.push('오늘은 아직 기록이 없어요');
    }
    const todo = plansOn(today).flatMap((p) => p.items);
    if (todo.length) lines.push(`오늘 계획 ${todo.filter((i) => i.done).length}/${todo.length} 완료`);
    const bits = [];
    const st = streak();
    if (st) bits.push(`연속 ${st}일째`);
    const dd = ddayInfo();
    if (dd) bits.push(`${dd.name} ${dd.label}`);
    if (bits.length) lines.push(bits.join(' · '));
    let text = lines.join('\n');
    if (extra && extra.trim()) text += `\n\n${extra.trim()}`;
    return text;
}

function sendToChat(text, now) {
    const ta = document.getElementById('send_textarea');
    if (!ta) {
        toastr.error('채팅 입력창을 찾지 못했어요');
        return;
    }
    ta.value = ta.value.trim() ? `${ta.value.trim()}\n${text}` : text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    closeModal();
    if (now) document.getElementById('send_but')?.click();
    else ta.focus();
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

const parseLines = (text) =>
    String(text || '')
        .split('\n')
        .map((l) => l.replace(/^\s*(?:[-*•]|\[[ xX]?\])\s*/, '').trim())
        .filter(Boolean);

function upsertPlan(d, id) {
    const s = S();
    const title = String(d.title || '').trim();
    if (!title) {
        toastr.warning('제목을 입력해 주세요');
        return false;
    }
    let start = isDateKey(d.start) ? d.start : dayKey(Date.now());
    let end = isDateKey(d.end) ? d.end : start;
    if (end < start) [start, end] = [end, start];

    const existing = id ? s.plans.find((p) => p.id === id) : null;
    const prev = new Map((existing?.items || []).map((i) => [i.text, i]));
    const items = parseLines(d.itemsText).map((t) => ({
        id: prev.get(t)?.id || uid(),
        text: t,
        done: prev.get(t)?.done || false,
    }));

    if (existing) {
        Object.assign(existing, { title, start, end, items });
        if (d.parentId !== undefined) existing.parentId = d.parentId || '';
    } else {
        s.plans.push({ id: uid(), title, start, end, parentId: d.parentId || '', items });
    }
    commit();
    refreshInjection();
    return true;
}

function deletePlan(id) {
    const s = S();
    s.plans = s.plans.filter((p) => p.id !== id);
    s.plans.forEach((p) => {
        if (p.parentId === id) p.parentId = '';
    });
    commit();
    refreshInjection();
}

function parsePlans(raw) {
    let text = String(raw ?? '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
        const obj = JSON.parse(text.slice(a, b + 1));
        if (!Array.isArray(obj.plans)) return null;
        const today = dayKey(Date.now());
        return obj.plans
            .filter((p) => p && typeof p.title === 'string' && p.title.trim())
            .map((p) => {
                const start = isDateKey(p.start) ? p.start : today;
                const end = isDateKey(p.end) ? p.end : start;
                const match = S().plans.find((x) => x.title.trim().toLowerCase() === p.title.trim().toLowerCase());
                return {
                    title: p.title.trim(),
                    start: end < start ? end : start,
                    end: end < start ? start : end,
                    itemsText: (Array.isArray(p.items) ? p.items : []).map((i) => String(i)).join('\n'),
                    matchId: match?.id || '',
                    include: true,
                };
            });
    } catch (e) {
        console.warn(`[${MODULE}] failed to parse plans`, e);
        return null;
    }
}

let busy = false;
async function extractPlans() {
    if (busy) return;
    const c = ctx();
    if (typeof c.generateRaw !== 'function') {
        toastr.error('이 SillyTavern 버전에서는 대화 정리를 쓸 수 없어요');
        return;
    }
    const msgs = (c.chat || [])
        .filter((m) => m && !m.is_system && m.mes)
        .slice(-30)
        .map((m) => `${m.is_user ? 'USER' : 'CHARACTER'}: ${String(m.mes).replace(/<[^>]*>/g, '').slice(0, 1500)}`);
    if (!msgs.length) {
        toastr.info('정리할 대화가 아직 없어요');
        return;
    }
    let convo = msgs.join('\n\n');
    if (convo.length > 14000) convo = convo.slice(-14000);

    const today = dayKey(Date.now());
    const existing = S().plans.map((p) => `- ${p.title} (${p.start} to ${p.end})`).join('\n') || '(none)';
    const dd = ddayInfo();

    const systemPrompt = [
        'You extract study plans from a chat between the user and a character.',
        'Return ONLY a JSON object, with no markdown fences and no commentary:',
        '{"plans":[{"title":"string","start":"YYYY-MM-DD","end":"YYYY-MM-DD","items":["string"]}]}',
        'Rules:',
        '- Include only plans the user actually decided on or agreed to. Never invent plans.',
        '- Resolve relative dates (tomorrow, next week, this month, until the exam) from today\'s date. "start" and "end" are inclusive; a single-day plan has start equal to end.',
        '- Write titles and items in the same language the user writes in. Keep each item short and concrete.',
        '- If the conversation changes or refines a plan listed under EXISTING PLANS, output the full updated version using the same title.',
        '- If the conversation contains no plan, return {"plans":[]}.',
    ].join('\n');

    const prompt = [
        `Today: ${today} (${WEEKDAYS_EN[parseKey(today).getDay()]})`,
        dd ? `Goal date: ${dd.name} on ${S().ddayDate}` : '',
        'EXISTING PLANS:',
        existing,
        '',
        'CONVERSATION:',
        convo,
    ]
        .filter((l) => l !== '')
        .join('\n');

    busy = true;
    renderModal();
    try {
        const out = await c.generateRaw({ prompt, systemPrompt });
        const drafts = parsePlans(out);
        if (!drafts) {
            toastr.warning('결과를 해석하지 못했어요. 다시 시도해 주세요');
        } else if (!drafts.length) {
            toastr.info('대화에서 확정된 계획을 찾지 못했어요');
        } else {
            view = { type: 'proposals', drafts };
            tab = 'plans';
        }
    } catch (e) {
        console.error(`[${MODULE}] extract failed`, e);
        toastr.error('정리에 실패했어요. API 연결을 확인해 주세요');
    } finally {
        busy = false;
        renderModal();
    }
}

/* ------------------------------------------------------------------ */
/* Focus mode                                                          */
/* ------------------------------------------------------------------ */

let focusEl = null;
let wakeLock = null;
let barTimer = null;

function avatarURL() {
    const s = S();
    if (s.focusImage) return s.focusImage;
    const { characters, characterId } = ctx();
    const file = characters?.[characterId]?.avatar;
    return file ? `/thumbnail?type=avatar&file=${encodeURIComponent(file)}` : '';
}

async function requestWake() {
    try {
        if ('wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                wakeLock = null;
            });
        }
    } catch (e) {
        console.debug(`[${MODULE}] wake lock unavailable`, e);
    }
}

async function releaseWake() {
    try {
        await wakeLock?.release();
    } catch (e) {
        /* ignore */
    }
    wakeLock = null;
}

function openFocus() {
    const s = S();
    if (!s.running) {
        toastr.info('먼저 공부를 시작해 주세요');
        return;
    }
    if (focusEl) return;
    closeModal();

    const url = avatarURL();
    focusEl = document.createElement('div');
    focusEl.id = 'sp_focus';
    focusEl.className = 'sp-focus';
    focusEl.style.setProperty('--sp-accent', s.accent);
    focusEl.innerHTML = `
        <div class="sp-focus-inner">
            ${url ? `<img class="sp-focus-avatar" src="${esc(url)}" alt="">` : `<div class="sp-focus-avatar sp-focus-noimg">${FA('book-open')}</div>`}
            <div class="sp-focus-sub">${esc(s.running.subject)}</div>
            <div class="sp-focus-time" data-live="focus-time">${fmtClock(Date.now() - s.running.start, s.showSeconds)}</div>
        </div>
        <div class="sp-focus-bar">
            <button class="sp-btn ghost" data-f="min">${FA('compress')} 접기</button>
            <button class="sp-btn danger" data-f="stop">${FA('stop')} 종료</button>
        </div>
        <div class="sp-focus-hint">화면을 탭하면 버튼이 나타나요</div>`;

    focusEl.querySelector('img')?.addEventListener('error', (e) => {
        e.target.style.display = 'none';
    });
    focusEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-f]');
        if (btn) {
            e.stopPropagation();
            if (btn.dataset.f === 'min') closeFocus();
            if (btn.dataset.f === 'stop') stopSession().catch(reportError);
            return;
        }
        focusEl.classList.add('show-bar');
        clearTimeout(barTimer);
        barTimer = setTimeout(() => focusEl?.classList.remove('show-bar'), 4000);
    });
    document.body.appendChild(focusEl);
    guardOverlay(focusEl, 10001, '#000');
    requestWake();
    scheduleTick();
    updatePill();
}

function closeFocus() {
    clearTimeout(barTimer);
    focusEl?.remove();
    focusEl = null;
    releaseWake();
    updatePill();
}

/* ------------------------------------------------------------------ */
/* Ticker: recompute from timestamps, never count                      */
/* ------------------------------------------------------------------ */

let tickTimer = null;

function updateLive() {
    const s = S();
    const r = s.running;
    const el = r ? fmtClock(Date.now() - r.start, s.showSeconds) : '';
    if (modalEl) {
        const e = modalEl.querySelector('[data-live="elapsed"]');
        if (e && r) e.textContent = el;
        const t = modalEl.querySelector('[data-live="total"]');
        if (t) t.textContent = fmtDur(msOnDay(dayKey(Date.now())));
    }
    if (focusEl && r) {
        const f = focusEl.querySelector('[data-live="focus-time"]');
        if (f) f.textContent = el;
    }
    const pill = document.getElementById('sp_pill');
    if (pill && r) {
        const t = pill.querySelector('[data-live="pill"]');
        if (t) t.textContent = fmtClock(Date.now() - r.start, false);
    }
}

function scheduleTick() {
    clearTimeout(tickTimer);
    tickTimer = null;
    const s = S();
    if (!s.running) return;
    updateLive();
    const elapsed = Date.now() - s.running.start;
    const fast = s.showSeconds && (modalEl || focusEl);
    const delay = fast ? 1000 - (elapsed % 1000) + 20 : MIN - (elapsed % MIN) + 50;
    tickTimer = setTimeout(scheduleTick, delay);
}

function createPill() {
    if (document.getElementById('sp_pill')) return;
    const pill = document.createElement('button');
    pill.id = 'sp_pill';
    pill.className = 'sp-pill';
    pill.style.display = 'none';
    pill.addEventListener('click', () => openFocus());
    document.body.appendChild(pill);
}

function updatePill() {
    const pill = document.getElementById('sp_pill');
    if (!pill) return;
    const s = S();
    const show = s.enabled && s.showPill && s.running && !focusEl && !modalEl;
    pill.style.display = show ? '' : 'none';
    pill.style.setProperty('--sp-accent', s.accent);
    if (show) {
        pill.innerHTML = `<span class="sp-dot"></span><span data-live="pill">${fmtClock(Date.now() - s.running.start, false)}</span><span class="sp-pill-sub">${esc(s.running.subject)}</span>`;
    }
}

/* ------------------------------------------------------------------ */
/* Modal UI                                                            */
/* ------------------------------------------------------------------ */

let modalEl = null;
let tab = 'today';
let view = null; // null | {type:'edit', id, draft} | {type:'proposals', drafts}
let extraDraft = '';

const TABS = [
    ['today', '오늘', 'sun'],
    ['plans', '계획', 'list-check'],
    ['log', '기록', 'chart-simple'],
    ['settings', '설정', 'sliders'],
];

function openModal(which) {
    if (which) {
        tab = which;
        view = null;
    }
    if (modalEl) {
        renderModal();
        return;
    }
    const s = S();
    modalEl = document.createElement('div');
    modalEl.id = 'sp_modal';
    modalEl.className = 'sp-modal';
    modalEl.style.setProperty('--sp-accent', s.accent);
    modalEl.innerHTML = `
        <div class="sp-sheet" role="dialog" aria-label="Study Planner">
            <header class="sp-head">
                <div class="sp-title">Study Planner <span class="sp-beta">beta</span></div>
                <button class="sp-icon" data-act="close" aria-label="닫기">${FA('xmark')}</button>
            </header>
            <nav class="sp-tabs">
                ${TABS.map(([id, label, icon]) => `<button class="sp-tab" data-act="tab" data-tab="${id}">${FA(icon)}<span>${label}</span></button>`).join('')}
            </nav>
            <div class="sp-body" id="sp_body"></div>
        </div>`;
    modalEl.addEventListener('click', onModalClick);
    modalEl.addEventListener('change', onModalChange);
    modalEl.addEventListener('input', (e) => {
        if (e.target.id === 'sp_extra') extraDraft = e.target.value;
    });
    document.body.appendChild(modalEl);
    guardOverlay(modalEl, 10000, '#141518');
    updatePill();
    renderModal();
    scheduleTick();
}

/** Open the modal from any entry point without letting an error disappear silently. */
function safeOpen(which) {
    try {
        openModal(which);
    } catch (e) {
        reportError(e);
        modalEl?.remove();
        modalEl = null;
    }
}

function closeModal() {
    modalEl?.remove();
    modalEl = null;
    view = null;
    updatePill();
}

function renderModal() {
    if (!modalEl) return;
    const body = modalEl.querySelector('#sp_body');
    const top = body.scrollTop;
    modalEl.querySelectorAll('.sp-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    let html;
    if (view?.type === 'edit') html = viewEdit();
    else if (view?.type === 'proposals') html = viewProposals();
    else html = { today: tabToday, plans: tabPlans, log: tabLog, settings: tabSettings }[tab]();
    body.innerHTML = html;
    body.scrollTop = top;
    updateLive();
}

/* ---- Today ---- */

function chipsHTML() {
    const s = S();
    return s.subjects
        .map((n) => `<button class="sp-chip ${n === s.lastSubject ? 'active' : ''}" data-act="pick-subject" data-name="${esc(n)}">${esc(n)}</button>`)
        .join('');
}

function checklistHTML(plan) {
    return plan.items
        .map(
            (i) => `<li><label class="sp-check"><input type="checkbox" data-act="toggle" data-plan="${esc(plan.id)}" data-item="${esc(i.id)}" ${i.done ? 'checked' : ''}><span>${esc(i.text)}</span></label></li>`,
        )
        .join('');
}

function tabToday() {
    const s = S();
    const now = Date.now();
    const today = dayKey(now);
    const d = parseKey(today);
    const total = msOnDay(today);
    const by = [...subjectMs(today)].sort((a, b) => b[1] - a[1]);
    const dd = ddayInfo();
    const st = streak();
    const plans = plansOn(today).filter((p) => p.items.length);

    const pills = [
        dd ? `<span class="sp-pill-tag">${FA('flag')} ${esc(dd.name)} <b>${dd.label}</b></span>` : '',
        st ? `<span class="sp-pill-tag">${FA('fire')} <b>${st}</b>일 연속</span>` : '',
    ].join('');

    const timer = s.running
        ? `<section class="sp-card sp-timer">
                <div class="sp-timer-sub"><span class="sp-dot"></span>${esc(s.running.subject)}</div>
                <div class="sp-timer-time" data-live="elapsed">${fmtClock(now - s.running.start, s.showSeconds)}</div>
                <div class="sp-actions">
                    <button class="sp-btn" data-act="focus">${FA('expand')} 집중 모드</button>
                    <button class="sp-btn danger" data-act="stop">${FA('stop')} 종료</button>
                </div>
            </section>`
        : `<section class="sp-card">
                <div class="sp-label">과목</div>
                <div class="sp-chips">${chipsHTML()}</div>
                <div class="sp-inline">
                    <input id="sp_new_subject" type="text" placeholder="새 과목 이름" maxlength="20">
                    <button class="sp-btn ghost" data-act="add-subject">추가</button>
                </div>
                <button class="sp-btn primary big" data-act="start">${FA('play')} 공부 시작</button>
            </section>`;

    const breakdown = by.length
        ? `<section class="sp-card">
                <div class="sp-label">오늘 과목별</div>
                ${by
                    .map(
                        ([name, ms]) => `<div class="sp-brow"><div class="sp-brow-top"><span>${esc(name)}</span><span>${fmtDur(ms)}</span></div><div class="sp-meter"><div style="width:${Math.max(4, Math.round((ms / total) * 100))}%"></div></div></div>`,
                    )
                    .join('')}
            </section>`
        : '';

    const planCard = plans.length
        ? `<section class="sp-card">
                <div class="sp-label">오늘 할 일</div>
                ${plans.map((p) => `<div class="sp-planblock"><div class="sp-planblock-t">${esc(p.title)} <small>${rangeLabel(p.start, p.end)}</small></div><ul class="sp-checks">${checklistHTML(p)}</ul></div>`).join('')}
            </section>`
        : `<section class="sp-card sp-empty">
                <div>오늘 계획이 아직 없어요</div>
                <small>캐릭터와 계획을 이야기한 뒤 계획 탭에서 '대화에서 정리'를 눌러 보세요</small>
            </section>`;

    const chatCard = `<section class="sp-card">
            <div class="sp-label">채팅으로 보내기</div>
            <pre class="sp-preview">${esc(buildReport(''))}</pre>
            <textarea id="sp_extra" rows="2" placeholder="함께 보낼 말 (선택)">${esc(extraDraft)}</textarea>
            <div class="sp-actions">
                <button class="sp-btn ghost" data-act="send-fill">${FA('pen')} 입력창에 넣기</button>
                <button class="sp-btn" data-act="send-now">${FA('paper-plane')} 바로 보내기</button>
            </div>
        </section>`;

    return `
        <section class="sp-hero">
            <div>
                <div class="sp-date">${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일</div>
                <div class="sp-today">오늘 <b data-live="total">${fmtDur(total)}</b></div>
            </div>
            <div class="sp-pills">${pills}</div>
        </section>
        ${timer}${breakdown}${planCard}${chatCard}`;
}

/* ---- Plans ---- */

function planCardHTML(p) {
    const { total, done } = planCount(p);
    const parent = p.parentId ? S().plans.find((x) => x.id === p.parentId) : null;
    const today = dayKey(Date.now());
    const status = p.start <= today && today <= p.end ? '진행 중' : p.start > today ? '예정' : '지남';
    const metaParts = [rangeLabel(p.start, p.end), status];
    if (parent) metaParts.push(`상위: ${esc(parent.title)}`);
    return `
        <article class="sp-card sp-plan">
            <div class="sp-plan-head">
                <div>
                    <div class="sp-plan-title">${esc(p.title)}</div>
                    <div class="sp-plan-meta">${metaParts.join(' · ')}</div>
                </div>
                <div class="sp-plan-tools">
                    <button class="sp-icon" data-act="plan-edit" data-id="${esc(p.id)}" aria-label="수정">${FA('pen')}</button>
                    <button class="sp-icon" data-act="plan-del" data-id="${esc(p.id)}" aria-label="삭제">${FA('trash')}</button>
                </div>
            </div>
            ${total ? `<div class="sp-progress"><div class="sp-meter"><div style="width:${Math.round((done / total) * 100)}%"></div></div><span>${done}/${total}</span></div><ul class="sp-checks">${checklistHTML(p)}</ul>` : '<div class="sp-muted">할 일이 없어요. 수정에서 추가해 보세요</div>'}
        </article>`;
}

function tabPlans() {
    const s = S();
    const today = dayKey(Date.now());
    const active = s.plans.filter((p) => p.start <= today && today <= p.end).sort((a, b) => spanDays(a) - spanDays(b));
    const upcoming = s.plans.filter((p) => p.start > today).sort((a, b) => a.start.localeCompare(b.start));
    const past = s.plans.filter((p) => p.end < today).sort((a, b) => b.end.localeCompare(a.end));
    const group = (label, list) => (list.length ? `<div class="sp-group">${label}</div>${list.map(planCardHTML).join('')}` : '');

    return `
        <div class="sp-actions sp-top-actions">
            <button class="sp-btn primary" data-act="plan-new">${FA('plus')} 새 계획</button>
            <button class="sp-btn" data-act="plan-extract" ${busy ? 'disabled' : ''}>${busy ? FA('spinner', 'fa-spin') + ' 정리 중…' : FA('wand-magic-sparkles') + ' 대화에서 정리'}</button>
        </div>
        ${s.plans.length ? '' : `<section class="sp-card sp-empty"><div>아직 계획이 없어요</div><small>기간은 하루든 몇 달이든 자유롭게 정할 수 있어요</small></section>`}
        ${group('진행 중', active)}
        ${group('예정', upcoming)}
        ${group('지난 계획', past)}`;
}

function planForm(d, idx, opts = {}) {
    const parents = S().plans.filter((p) => p.id !== opts.selfId);
    return `
        <div class="sp-card sp-form" data-form="${idx}" data-match="${esc(d.matchId || '')}">
            ${opts.include !== undefined ? `<label class="sp-check sp-include"><input type="checkbox" data-f="include" ${opts.include ? 'checked' : ''}><span>이 계획 저장${d.matchId ? ' <em>(같은 제목의 기존 계획을 덮어써요)</em>' : ''}</span></label>` : ''}
            <label class="sp-field"><span>제목</span><input type="text" data-f="title" value="${esc(d.title)}" placeholder="예: 11월 목표"></label>
            <div class="sp-row2">
                <label class="sp-field"><span>시작</span><input type="date" data-f="start" value="${esc(d.start)}"></label>
                <label class="sp-field"><span>끝</span><input type="date" data-f="end" value="${esc(d.end)}"></label>
            </div>
            ${opts.parent ? `<label class="sp-field"><span>상위 계획 (선택)</span><select data-f="parent"><option value="">없음</option>${parents.map((p) => `<option value="${esc(p.id)}" ${p.id === d.parentId ? 'selected' : ''}>${esc(p.title)} (${rangeLabel(p.start, p.end)})</option>`).join('')}</select></label>` : ''}
            <label class="sp-field"><span>할 일 <small>한 줄에 하나씩</small></span><textarea data-f="items" rows="6">${esc(d.itemsText)}</textarea></label>
        </div>`;
}

function readForms() {
    return [...modalEl.querySelectorAll('[data-form]')].map((f) => {
        const get = (k) => f.querySelector(`[data-f="${k}"]`);
        return {
            title: get('title')?.value || '',
            start: get('start')?.value || '',
            end: get('end')?.value || '',
            parentId: get('parent') ? get('parent').value : undefined,
            itemsText: get('items')?.value || '',
            include: get('include') ? get('include').checked : true,
            matchId: f.dataset.match || '',
        };
    });
}

function viewEdit() {
    return `
        <div class="sp-back"><button class="sp-btn ghost" data-act="plan-cancel">${FA('chevron-left')} 목록</button></div>
        ${planForm(view.draft, 0, { parent: true, selfId: view.id })}
        <div class="sp-actions">
            <button class="sp-btn ghost" data-act="plan-cancel">취소</button>
            <button class="sp-btn primary" data-act="plan-save">${FA('check')} 저장</button>
        </div>`;
}

function viewProposals() {
    return `
        <div class="sp-back"><button class="sp-btn ghost" data-act="plan-cancel">${FA('chevron-left')} 목록</button></div>
        <section class="sp-card sp-note">대화에서 ${view.drafts.length}개의 계획을 찾았어요. 저장하기 전에 자유롭게 고쳐 보세요.</section>
        ${view.drafts.map((d, i) => planForm(d, i, { include: d.include })).join('')}
        <div class="sp-actions">
            <button class="sp-btn ghost" data-act="plan-cancel">취소</button>
            <button class="sp-btn primary" data-act="proposals-save">${FA('check')} 선택한 계획 저장</button>
        </div>`;
}

/* ---- Log ---- */

function tabLog() {
    const s = S();
    const now = Date.now();
    const list = allSessions();
    const keys = weekKeys();
    const vals = keys.map((k) => msOnDay(k, list));
    const max = Math.max(...vals, 1);
    const weekTotal = vals.reduce((a, b) => a + b, 0);
    const allTotal = list.reduce((sum, x) => sum + (x.end - x.start), 0);
    const today = dayKey(now);

    const bars = keys
        .map(
            (k, i) => `<div class="sp-bar ${k === today ? 'today' : ''}"><div class="sp-bar-val">${vals[i] ? (vals[i] / HOUR).toFixed(1) : ''}</div><div class="sp-bar-track"><div class="sp-bar-fill" style="height:${vals[i] ? Math.max(4, Math.round((vals[i] / max) * 100)) : 0}%"></div></div><div class="sp-bar-lab">${wdLabel(k)}</div></div>`,
        )
        .join('');

    const recent = [...s.sessions].sort((a, b) => b.start - a.start).slice(0, 40);
    const rows = recent
        .map((x) => {
            const k = dayKey(x.start);
            return `<div class="sp-row"><div class="sp-row-main"><div>${mdLabel(k)}(${wdLabel(k)}) ${clockOf(x.start)}–${clockOf(x.end)}</div><small>${esc(x.subject)} · ${fmtDur(x.end - x.start)}</small></div><button class="sp-icon" data-act="log-del" data-id="${esc(x.id)}" aria-label="삭제">${FA('trash')}</button></div>`;
        })
        .join('');

    const nowD = new Date(now - HOUR);
    const manual = `
        <section class="sp-card">
            <div class="sp-label">직접 기록 추가</div>
            <div class="sp-row2">
                <label class="sp-field"><span>날짜</span><input id="sp_log_date" type="date" value="${fmtDate(nowD)}"></label>
                <label class="sp-field"><span>시작 시각</span><input id="sp_log_time" type="time" value="${pad(nowD.getHours())}:${pad(nowD.getMinutes())}"></label>
            </div>
            <div class="sp-row2">
                <label class="sp-field"><span>시간(분)</span><input id="sp_log_min" type="number" min="1" max="1440" value="60" inputmode="numeric"></label>
                <label class="sp-field"><span>과목</span><select id="sp_log_sub">${s.subjects.map((n) => `<option ${n === s.lastSubject ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
            </div>
            <button class="sp-btn" data-act="log-add">${FA('plus')} 추가</button>
        </section>`;

    return `
        <div class="sp-stats">
            <div class="sp-stat"><b>${fmtDur(weekTotal)}</b><small>최근 7일</small></div>
            <div class="sp-stat"><b>${streak()}일</b><small>연속</small></div>
            <div class="sp-stat"><b>${fmtDur(allTotal)}</b><small>누적</small></div>
        </div>
        <section class="sp-card"><div class="sp-label">최근 7일 (시간)</div><div class="sp-bars">${bars}</div></section>
        <section class="sp-card"><div class="sp-label">최근 기록</div>${rows || '<div class="sp-muted">아직 기록이 없어요</div>'}</section>
        ${manual}`;
}

/* ---- Settings ---- */

function tabSettings() {
    const s = S();
    const row = (label, control, hint) =>
        `<div class="sp-set"><div class="sp-set-l"><div>${label}</div>${hint ? `<small>${hint}</small>` : ''}</div><div class="sp-set-c">${control}</div></div>`;
    const sw = (key) => `<label class="sp-switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span></span></label>`;
    const num = (key, min, max) => `<input class="sp-num" type="number" inputmode="numeric" min="${min}" max="${max}" data-set="${key}" value="${s[key]}">`;

    return `
        <section class="sp-card">
            <div class="sp-label">캐릭터 연동</div>
            ${row('프롬프트에 기록 넣기', sw('inject'), '공부 기록 요약을 참고 정보로만 전달해요. 성격은 봇카드를 따라요')}
            ${row('주입 깊이', num('injectDepth', 0, 10), '0이 가장 마지막 메시지 쪽이에요')}
        </section>
        <section class="sp-card">
            <div class="sp-label">집중 모드</div>
            ${row('시작하면 자동으로 열기', sw('autoFocus'))}
            ${row('초 단위로 표시', sw('showSeconds'), '꺼 두면 1분에 한 번만 갱신해요')}
            ${row('진행 중 표시 띠', sw('showPill'), '공부 중 화면 한쪽에 작게 표시해요')}
            ${row('프로필 이미지 주소', `<input class="sp-text" type="text" data-set="focusImage" value="${esc(s.focusImage)}" placeholder="비우면 캐릭터 프사">`)}
        </section>
        <section class="sp-card">
            <div class="sp-label">기록 기준</div>
            ${row('하루 시작 시각', num('dayStartHour', 0, 12), '새벽 공부를 전날로 묶어요 (기본 4시)')}
            ${row('연속일 인정 기준(분)', num('streakMinMinutes', 1, 600))}
            ${row('목표 이름', `<input class="sp-text" type="text" data-set="ddayName" value="${esc(s.ddayName)}" placeholder="예: 시험">`)}
            ${row('목표 날짜', `<input class="sp-text" type="date" data-set="ddayDate" value="${esc(s.ddayDate)}">`)}
        </section>
        <section class="sp-card">
            <div class="sp-label">과목</div>
            <div class="sp-chips">${s.subjects.map((n) => `<span class="sp-chip">${esc(n)}<button data-act="del-subject" data-name="${esc(n)}" aria-label="삭제">${FA('xmark')}</button></span>`).join('')}</div>
            <div class="sp-inline"><input id="sp_new_subject" type="text" placeholder="새 과목 이름" maxlength="20"><button class="sp-btn ghost" data-act="add-subject">추가</button></div>
        </section>
        <section class="sp-card">
            <div class="sp-label">디자인</div>
            ${row('강조 색', `<input class="sp-color" type="color" data-set="accent" value="${esc(s.accent)}">`)}
        </section>
        <section class="sp-card">
            <div class="sp-label">데이터</div>
            <div class="sp-actions">
                <button class="sp-btn ghost" data-act="export">${FA('download')} 내보내기</button>
                <button class="sp-btn ghost" data-act="import">${FA('upload')} 가져오기</button>
            </div>
            <input id="sp_import_file" type="file" accept="application/json,.json" hidden>
        </section>`;
}

/* ---- Event handling ---- */

async function confirmDialog(title, text) {
    const { Popup, POPUP_RESULT } = ctx();
    if (!Popup?.show?.confirm) return window.confirm(text);
    const r = await Popup.show.confirm(title, text);
    return r === true || r === 1 || (POPUP_RESULT && r === POPUP_RESULT.AFFIRMATIVE);
}

function newDraft() {
    const t = dayKey(Date.now());
    return { title: '', start: t, end: t, parentId: '', itemsText: '' };
}

function addSubject(name) {
    name = String(name || '').trim();
    if (!name) return;
    const s = S();
    if (!s.subjects.includes(name)) s.subjects.push(name);
    s.lastSubject = name;
    commit();
}

const handlers = {
    close: () => closeModal(),
    tab: (el) => {
        tab = el.dataset.tab;
        view = null;
        renderModal();
    },
    start: () => startSession(S().lastSubject),
    stop: () => stopSession(),
    focus: () => openFocus(),
    'pick-subject': (el) => {
        S().lastSubject = el.dataset.name;
        commit();
        renderModal();
    },
    'add-subject': () => {
        addSubject(modalEl.querySelector('#sp_new_subject')?.value);
        renderModal();
    },
    'del-subject': (el) => {
        const s = S();
        if (s.subjects.length <= 1) {
            toastr.info('과목은 최소 하나는 있어야 해요');
            return;
        }
        s.subjects = s.subjects.filter((n) => n !== el.dataset.name);
        if (!s.subjects.includes(s.lastSubject)) s.lastSubject = s.subjects[0];
        commit();
        renderModal();
    },
    toggle: (el) => {
        const plan = S().plans.find((p) => p.id === el.dataset.plan);
        const item = plan?.items.find((i) => i.id === el.dataset.item);
        if (!item) return;
        item.done = el.checked;
        commit();
        refreshInjection();
        renderModal();
    },
    'send-fill': () => sendToChat(buildReport(extraDraft), false),
    'send-now': () => {
        const text = buildReport(extraDraft);
        extraDraft = '';
        sendToChat(text, true);
    },
    'plan-new': () => {
        view = { type: 'edit', id: null, draft: newDraft() };
        renderModal();
    },
    'plan-edit': (el) => {
        const p = S().plans.find((x) => x.id === el.dataset.id);
        if (!p) return;
        view = { type: 'edit', id: p.id, draft: { title: p.title, start: p.start, end: p.end, parentId: p.parentId, itemsText: p.items.map((i) => i.text).join('\n') } };
        renderModal();
    },
    'plan-del': async (el) => {
        const p = S().plans.find((x) => x.id === el.dataset.id);
        if (!p || !(await confirmDialog('계획 삭제', `"${p.title}" 계획을 삭제할까요?`))) return;
        deletePlan(p.id);
        renderModal();
    },
    'plan-cancel': () => {
        view = null;
        renderModal();
    },
    'plan-save': () => {
        const [d] = readForms();
        if (upsertPlan(d, view.id)) {
            view = null;
            renderModal();
        }
    },
    'plan-extract': () => extractPlans(),
    'proposals-save': () => {
        const drafts = readForms().filter((d) => d.include);
        if (!drafts.length) {
            toastr.info('저장할 계획을 선택해 주세요');
            return;
        }
        let ok = 0;
        for (const d of drafts) if (upsertPlan({ ...d, parentId: undefined }, d.matchId || null)) ok++;
        if (ok) toastr.success(`${ok}개의 계획을 저장했어요`);
        view = null;
        renderModal();
    },
    'log-add': () => {
        const q = (id) => modalEl.querySelector(id)?.value;
        const [y, mo, da] = String(q('#sp_log_date')).split('-').map(Number);
        const [h, mi] = String(q('#sp_log_time')).split(':').map(Number);
        const minutes = parseInt(q('#sp_log_min'), 10);
        const start = new Date(y, mo - 1, da, h, mi).getTime();
        if (!Number.isFinite(start) || !(minutes >= 1 && minutes <= 1440)) {
            toastr.warning('날짜, 시각, 시간(분)을 확인해 주세요');
            return;
        }
        const subject = q('#sp_log_sub') || S().lastSubject;
        S().sessions.push({ id: uid(), start, end: start + minutes * MIN, subject });
        commit();
        refreshInjection();
        toastr.success('기록을 추가했어요');
        renderModal();
    },
    'log-del': async (el) => {
        if (!(await confirmDialog('기록 삭제', '이 기록을 삭제할까요?'))) return;
        const s = S();
        s.sessions = s.sessions.filter((x) => x.id !== el.dataset.id);
        commit();
        refreshInjection();
        renderModal();
    },
    export: () => exportData(),
    import: () => modalEl.querySelector('#sp_import_file')?.click(),
};

function onModalClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) {
        if (e.target === modalEl) closeModal();
        return;
    }
    try {
        const result = handlers[el.dataset.act]?.(el, e);
        if (result && typeof result.catch === 'function') result.catch(reportError);
    } catch (err) {
        reportError(err);
    }
}

function onModalChange(e) {
    if (e.target.id === 'sp_import_file') {
        importData(e.target.files?.[0]);
        e.target.value = '';
        return;
    }
    const el = e.target.closest('[data-set]');
    if (!el) return;
    const key = el.dataset.set;
    const s = S();
    let v;
    if (el.type === 'checkbox') {
        v = el.checked;
    } else if (el.type === 'number') {
        const min = Number(el.min);
        const max = Number(el.max);
        v = Math.min(max, Math.max(min, parseInt(el.value, 10) || min));
        el.value = v;
    } else {
        v = el.value.trim();
    }
    s[key] = v;
    commit();
    if (key === 'accent') {
        modalEl?.style.setProperty('--sp-accent', v);
        focusEl?.style.setProperty('--sp-accent', v);
    }
    refreshInjection();
    updatePill();
    scheduleTick();
}

/* ---- Export / import ---- */

function exportData() {
    const s = S();
    const payload = { app: MODULE, version: 1, exportedAt: Date.now(), subjects: s.subjects, sessions: s.sessions, plans: s.plans };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study-planner-${dayKey(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        if (data.app !== MODULE || !Array.isArray(data.sessions) || !Array.isArray(data.plans)) throw new Error('format');
        if (!(await confirmDialog('가져오기', '현재 기록과 계획을 가져온 파일로 바꿀까요?'))) return;
        const s = S();
        s.sessions = data.sessions.filter((x) => x && Number.isFinite(x.start) && Number.isFinite(x.end));
        s.plans = data.plans.filter((p) => p && p.title && isDateKey(p.start) && isDateKey(p.end)).map((p) => ({ ...p, items: Array.isArray(p.items) ? p.items : [] }));
        if (Array.isArray(data.subjects) && data.subjects.length) s.subjects = data.subjects.map(String);
        if (!s.subjects.includes(s.lastSubject)) s.lastSubject = s.subjects[0];
        commit();
        refreshInjection();
        toastr.success('가져왔어요');
        renderModal();
    } catch (e) {
        toastr.error('올바른 Study Planner 파일이 아니에요');
    }
}

/* ------------------------------------------------------------------ */
/* Extensions panel + menu                                             */
/* ------------------------------------------------------------------ */

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sp_menu_btn')) return;
    const item = document.createElement('div');
    item.id = 'sp_menu_btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="fa-solid fa-book-open-reader extensionsMenuExtensionButton"></div><span>Study Planner</span>`;
    item.addEventListener('click', () => safeOpen('today'));
    menu.appendChild(item);
}

function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2');
    if (!host || document.getElementById('sp_settings')) return;
    host.insertAdjacentHTML(
        'beforeend',
        `<div id="sp_settings" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Study Planner</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="sp_enabled" type="checkbox"><span>사용</span></label>
                    <div class="menu_button" id="sp_open_btn">Study Planner 열기</div>
                </div>
            </div>
        </div>`,
    );
    const enabled = document.getElementById('sp_enabled');
    enabled.checked = S().enabled;
    enabled.addEventListener('change', () => {
        S().enabled = enabled.checked;
        commit();
        refreshInjection();
        updatePill();
    });
    document.getElementById('sp_open_btn').addEventListener('click', () => safeOpen('today'));
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

let initialized = false;
function init() {
    if (initialized) return;
    initialized = true;
    const { eventSource, event_types } = ctx();

    // UI first, so the entry points exist even if a later step fails.
    for (const step of [addMenuButton, addSettingsPanel, createPill]) {
        try {
            step();
        } catch (e) {
            reportError(e);
        }
    }

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
        try {
            refreshInjection();
        } catch (e) {
            reportError(e);
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        try {
            refreshInjection();
            if (modalEl) renderModal();
        } catch (e) {
            reportError(e);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (focusEl) requestWake();
        scheduleTick();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (focusEl) closeFocus();
        else if (modalEl) closeModal();
    });

    try {
        refreshInjection();
        scheduleTick();
        updatePill();
    } catch (e) {
        reportError(e);
    }
    console.log(`[${MODULE}] loaded`);
}

{
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, init);
}

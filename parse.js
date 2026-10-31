// VN 모드 - 순수 파싱/상태 계산 (실리태번 비의존)

export const MAX_CHUNK = 90;
/** 문장 하나를 쉼표에서 억지로 자르기 시작하는 길이 (대사창 약 세 줄) */
const MAX_SENTENCE = 120;

/**
 * 화면 효과 이름 → 표준 이름. 실제 미연시 엔진(Ren'Py) 기본 효과를 기준으로 골랐다.
 * 문장 효과: vpunch, hpunch, flash / 장면 전환: fade, whiteout / 톤: flashback
 * (줌인은 뺐다. 예전 답장의 [fx:zoom] 표시는 글에서 지우기만 한다)
 */
const FX_ALIASES = {
    vpunch: 'vpunch', '세로흔들림': 'vpunch', '흔들림': 'vpunch', shake: 'vpunch',
    hpunch: 'hpunch', '가로흔들림': 'hpunch', sway: 'hpunch',
    flash: 'flash', '플래시': 'flash', '번쩍': 'flash',
    fade: 'fade', '암전': 'fade',
    whiteout: 'whiteout', '화이트아웃': 'whiteout',
    flashback: 'flashback', sepia: 'flashback', '회상': 'flashback',
    dissolve: 'dissolve', '디졸브': 'dissolve',
};

export function normFx(name) {
    return FX_ALIASES[String(name || '').trim().toLowerCase().replace(/\s+/g, '')] || '';
}

const LINE_FX = new Set(['vpunch', 'hpunch', 'flash']);
const CG_MARK_RE = /\[cg:(\d+)\]/g;
const FX_MARK_RE =/\[\s*(?:fx|효과)\s*[:：]\s*([^\]]+)\]/gi;
/** 효과음 표시 [sfx:문 열림]. 이름은 사용자 폴더의 파일 이름이라 그대로 둔다 */
const SFX_MARK_RE = /\[\s*(?:sfx|se|효과음)\s*[:：]\s*([^\]]+)\]/gi;

/** 본문 한 줄에서 [fx:…] · [sfx:…] 표시를 떼어 낸다 */
function takeFxMarks(line) {
    const fx = [];
    const sfx = [];
    const text = line.replace(SFX_MARK_RE, (_, names) => {
        for (const n of names.split(/[,|/]/)) if (n.trim()) sfx.push(n.trim());
        return '';
    }).replace(FX_MARK_RE, (_, names) => {
        for (const n of names.split(/[,|/]/)) {
            const f = normFx(n);
            if (LINE_FX.has(f)) fx.push(f);
        }
        return '';
    }).replace(/\s{2,}/g, ' ').trim();
    return { text, fx, sfx };
}

/** 상태 항목 라벨 → 태그 키 */
export function itemKey(item) {
    return String(item.label || '').trim().replace(/\s+/g, '_') || item.id;
}

/**
 * 진짜 블록 찾기. 프롬프트의 설계 메모 등이 "`<pickplay>` 블록 뒤에…"처럼 태그 이름만 언급해도
 * 거기서부터 끝까지 잘리지 않게, 줄 맨 앞에 있는 여는 태그만 블록 시작으로 보고 마지막 것을 쓴다.
 * 닫는 태그가 있으면 그 앞의 여는 태그와 짝짓고, 없으면 그 여는 태그부터 끝까지.
 * @returns {{start:number, end:number, inner:string}|null}
 */
export function findBlock(text, tag) {
    const src = String(text || '');
    const close = src.toLowerCase().lastIndexOf(`</${tag}>`);
    let open = null;
    for (const m of src.matchAll(new RegExp(`(^|\\n)[ \\t]*(<${tag}\\b[^>]*>)`, 'gi'))) {
        const at = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
        if (close >= 0 && at > close) break;
        open = { at, end: at + m[2].length };
    }
    if (!open) return null;
    const hasClose = close > open.at;
    return {
        start: open.at,
        end: hasClose ? close + tag.length + 3 : src.length,
        inner: src.slice(open.end, hasClose ? close : src.length),
    };
}

/** <pickplay> 블록 추출. 닫는 태그가 없으면 끝까지로 본다. */
export function extractPpBlock(text) {
    return findBlock(text, 'pickplay')?.inner ?? '';
}

/** 블록 하나를 지운다 (findBlock 규칙) */
function removeBlock(text, tag) {
    const b = findBlock(text, tag);
    return b ? text.slice(0, b.start) + text.slice(b.end) : text;
}

/**
 * 닫히지 않은 숨길 블록(답장이 중간에 잘린 설계 메모 등): 줄 맨 앞의 여는 태그부터
 * 다음 줄 맨 앞의 다른 태그(<prose> 등) 직전까지, 그런 태그가 없으면 끝까지 뺀다.
 */
function cutUnclosedHidden(s) {
    if (!hiddenTags.length) return s;
    const lines = s.split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        const tag = (line.match(/^\s*<([a-z][\w-]*)\b/i) || [])[1]?.toLowerCase();
        if (tag && hiddenTags.includes(tag)) { skipping = true; continue; }
        if (skipping && tag && !hiddenTags.includes(tag)) skipping = false;
        if (!skipping) out.push(line);
    }
    return out.join('\n');
}

/** VN 화면에서 통째로 뺄 블록 태그 (설계 메모·경고문·접기 등). 설정에서 바꿀 수 있다 */
let hiddenTags = [];
export function setHiddenTags(list) {
    hiddenTags = (list || []).map(t => String(t).trim().toLowerCase()).filter(t => /^[a-z][\w-]*$/.test(t));
    // AutoPic 그림 지시 블록은 설정과 상관없이 항상 숨긴다 (그림을 못 만들었거나 본문에 남겨 둔 경우 태그가 대사로 보이던 문제)
    if (!hiddenTags.includes('autopic')) hiddenTags.push('autopic');
}

const CHOICES_BLOCK_RE = /<choices\b[^>]*>([\s\S]*?)(?:<\/choices>|$)/gi;

/** 캐릭터 카드 등이 쓰는 <choices><c>…</c></choices> 형식의 선택지 */
export function extractChoicesBlock(text) {
    const out = [];
    for (const m of String(text || '').matchAll(CHOICES_BLOCK_RE)) {
        for (const c of m[1].matchAll(/<(c|choice|option)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
            const t = c[2].replace(/<[^>]+>/g, '').trim();
            if (t) out.push(t);
        }
    }
    return out.slice(0, 4);
}

/** <pickplay> 블록 + 호환 선택지 블록을 합쳐 파싱 */
export function parseMessagePp(text) {
    const pp = parsePpBlock(extractPpBlock(text));
    if (!pp.choices.length) pp.choices = extractChoicesBlock(text);
    return pp;
}

/**
 * <pickplay> 블록 파싱
 * status: 시간대=방과 후 | 호감도.서윤=+2
 * choice: A | B | C
 * fx: shake
 */
export function parsePpBlock(block) {
    const out = { status: [], choices: [], fx: [], transition: '', tone: '', bgm: '', errors: [] };
    if (!block) return out;
    for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z가-힣_]+)\s*[:：]\s*(.*)$/);
        if (!m) { out.errors.push(line); continue; }
        const key = m[1].toLowerCase();
        const body = m[2].trim();
        const parts = body.split('|').map(s => s.trim()).filter(Boolean);
        if (key === 'status' || key === '상태') {
            for (const p of parts) {
                const kv = p.match(/^([^=]+?)\s*=\s*(.*)$/);
                if (!kv) { out.errors.push(p); continue; }
                const [k, name] = splitKeyName(kv[1].trim());
                out.status.push({ key: k, name, value: stripQuotes(kv[2].trim()) });
            }
        } else if (key === 'choice' || key === 'choices' || key === '선택지') {
            out.choices.push(...parts.map(stripQuotes));
        } else if (key === 'fx' || key === '효과') {
            // 예전 형식(턴 시작에 재생). 장면 전환 이름이면 전환으로 옮긴다
            for (const p of parts.flatMap(x => x.split(','))) {
                const f = normFx(p);
                if (f === 'fade' || f === 'whiteout') out.transition = f;
                else if (f === 'flashback') out.tone = f;
                else if (f) out.fx.push(f);
            }
        } else if (key === 'transition' || key === '전환') {
            const f = normFx(parts[0]);
            if (f === 'fade' || f === 'whiteout' || f === 'dissolve') out.transition = f;
        } else if (key === 'tone' || key === '톤') {
            const f = normFx(parts[0]);
            if (f === 'flashback') out.tone = f;
        } else if (key === 'bgm' || key === 'music' || key === '음악' || key === '배경음') {
            out.bgm = stripQuotes(parts[0] || '');
        } else {
            out.errors.push(line);
        }
    }
    out.choices = out.choices.slice(0, 4);
    return out;
}

function splitKeyName(k) {
    const i = k.indexOf('.');
    if (i < 0) return [k, ''];
    return [k.slice(0, i).trim(), k.slice(i + 1).trim()];
}

/** 선택지 전체를 감싼 따옴표만 벗긴다. 「대사」라고 … 처럼 앞쪽만 따옴표인 경우는 그대로 둔다 */
function stripQuotes(s) {
    const t = String(s).trim();
    const m = t.match(/^(["'“‘「『])([\s\S]*)(["'”’」』])$/);
    return (m && !/["“”「」『』]/.test(m[2]) ? m[2] : t).trim();
}

/** 코드 블록(``` … ```) 자리. 상태창 HTML 등은 채팅창에서만 그려지므로 VN에서는 "TEXT로 보기" 한 줄로 바꾼다 */
export const EXTRA_MARK = '[[pp-extra]]';
const FENCE_RE = /```[^\n]*\n[\s\S]*?(?:```|$)/g;

/** 숨길 블록(상태 블록·그림 지시·숨길 태그·생각·스타일)만 뺀 글. 다른 태그는 남긴다 (정규식 화면이 있는지 볼 때) */
export function stripHiddenBlocks(text) {
    let s = String(text || '');
    s = removeBlock(s, 'pickplay');
    s = removeBlock(s, 'autopic');
    s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const tag of hiddenTags) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    s = cutUnclosedHidden(s);
    return s.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

/** 화면에 보일 본문만 남긴다 (태그·이미지·마크다운 제거) */
export function cleanText(text) {
    let s = String(text || '');
    s = removeBlock(s, 'pickplay');
    s = removeBlock(s, 'autopic');
    // 닫는 ```가 없으면 끝까지 코드로 본다. 남은 ``` 줄 조각도 지운다
    s = s.replace(FENCE_RE, `\n${EXTRA_MARK}\n`).replace(/^\s*`{3,}.*$/gm, '');
    // AutoPic 태그 치환 모드의 그림 자리 (<span data-autopic-slot>[AutoPic 이미지]</span>)는 안쪽 글자째 뺀다
    s = s.replace(/<(\w+)[^>]*data-autopic-slot=["'][^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/\[AutoPic 이미지\]/g, '');
    s = s.replace(/<choices\b[^>]*>[\s\S]*?<\/choices>/gi, '');
    // 스타일·스크립트, 그리고 숨길 태그 블록(닫는 태그가 있는 것만)은 내용째 뺀다
    s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const tag of hiddenTags) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    s = cutUnclosedHidden(s);
    // AutoPic 2.0 태그 치환 모드의 이미지 자리
    s = s.replace(/<span\b[^>]*data-autopic-slot[^>]*>[\s\S]*?<\/span>/gi, '');
    s = s.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<pic\b[^>]*>/gi, '');
    s = s.replace(/<img\b[^>]*>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    s = s.replace(/\*+/g, '').replace(/^\s*#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '');
    return s;
}

const SPEAKER_RE = /^([^\s:："“「'*-][^:："“「]{0,15}?)\s*[:：]\s*(.+)$/;
// 줄 앞 장식 기호 (■ 이름: 대사, - 이름: 대사 등)
const BULLET_RE = /^[■□▪▫●○◆◇◈▶▷►▸•・·※★☆\-–—>]+\s*/;

/** 대사창에 "정규식 읽기"로 나오는 줄 (누르면 정규식으로 그려진 화면만 크게) */
export function extraLine() {
    return { n: '', t: '정규식 읽기', extra: true };
}

/**
 * 본문 → [{n, t, fx?}] 문장 목록.
 * 줄 안의 [fx:세로흔들림] 같은 표시는 떼어서 그 문장의 fx로 붙인다 (표시만 있는 줄은 다음 문장에).
 */
export function splitLines(text) {
    const lines = [];
    let pendingFx = [];
    let pendingSfx = [];
    let pendingCg = null;
    const push = (n, t) => {
        const first = lines.length;
        for (const c of chunk(t)) lines.push({ n, t: c });
        if (pendingFx.length && lines[first]) { lines[first].fx = pendingFx; pendingFx = []; }
        if (pendingSfx.length && lines[first]) { lines[first].sfx = pendingSfx; pendingSfx = []; }
        if (pendingCg != null && lines[first]) { lines[first].cgAt = pendingCg; pendingCg = null; }
    };
    for (let raw of cleanText(text).split(/\r?\n/)) {
        // [cg:N] = 이 자리에 N번째 그림 (index.js가 AutoPic 이미지 위치에 넣는다). 다음 문장부터 그 그림
        raw = raw.replace(CG_MARK_RE, (_, k) => { pendingCg = Number(k); return ''; });
        // 채팅창에서만 보이는 화면 자리 (연달아 있으면 한 번만)
        if (raw.trim() === EXTRA_MARK) {
            if (!lines[lines.length - 1]?.extra) lines.push(extraLine());
            continue;
        }
        const marked = takeFxMarks(raw.trim());
        pendingFx.push(...marked.fx);
        pendingSfx.push(...marked.sfx);
        const line = marked.text.replace(BULLET_RE, '');
        if (!line || /^[-=_~·.]{3,}$/.test(line)) continue;
        const m = line.match(SPEAKER_RE);
        if (m && !/^https?$/i.test(m[1])) {
            // 이름: [sfx:…]대사 처럼 대사 앞에 붙은 표시도 그 문장에
            const inner = takeFxMarks(m[2].trim());
            pendingFx.push(...inner.fx);
            pendingSfx.push(...inner.sfx);
            push(m[1].trim(), stripWrappingQuotes(inner.text));
        } else {
            push('', line);
        }
    }
    // 그림이 본문 맨 끝(선택지 블록 뒤 등)에 있어 뒤따르는 문장이 없으면 마지막 문장에서 보여 준다
    if (pendingCg != null && lines.length) {
        const last = lines[lines.length - 1];
        if (last.cgAt == null) last.cgAt = pendingCg;
    }
    return lines;
}

function stripWrappingQuotes(t) {
    const m = t.match(/^["“「『](.*)["”」』]$/);
    return m ? m[1].trim() : t;
}

/** 긴 문장을 대사창에 들어가도록 문장 경계에서 나눈다 */
export function chunk(text, max = MAX_CHUNK) {
    if (text.length <= max) return [text];
    // 문장 끝(일본어·중국어처럼 띄어쓰기 없이 이어지는 경우 포함)에서 나눈다
    const sentences = text.split(/(?<=[.!?。！？…~♪]["”’」』)]?)\s*/).filter(Boolean);
    const out = [];
    let cur = '';
    const joinOf = (a, b) => (a && !/[。！？」』]$/.test(a) ? a + ' ' + b : a + b);
    for (const s of sentences) {
        const next = cur ? joinOf(cur, s) : s;
        if (cur && next.length > max) { out.push(cur); cur = s; }
        else cur = next;
    }
    if (cur) out.push(cur);
    // 한 문장은 되도록 통째로 둔다. 대사창 세 줄을 넘길 만큼(MAX_SENTENCE) 길 때만 쉼표·띄어쓰기에서 자른다
    return out.flatMap(s => hardSplit(s.trim(), Math.max(max, MAX_SENTENCE))).filter(Boolean);
}

function hardSplit(s, max) {
    const parts = [];
    while (s.length > max) {
        const head = s.slice(0, max);
        let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('、'), head.lastIndexOf('，'));
        if (cut < max * 0.4) cut = head.lastIndexOf(' ');
        if (cut < max * 0.4) cut = max - 1;
        parts.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
    }
    if (s) parts.push(s);
    return parts;
}

export function emptyState(items) {
    // mind: 캐릭터마다 한 줄 글 (카오모지 + 속마음)
    const st = { text: {}, gauge: {}, mind: {} };
    for (const it of items) {
        const k = itemKey(it);
        if (it.type === 'gauge') st.gauge[k] = {};
        else if (it.type === 'mind') st.mind[k] = {};
        else st.text[k] = '';
    }
    return st;
}

export function clampGauge(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
}

export const GAUGE_DEFAULT = 50;

const GRADE_ALIASES = { '++': '++', '+': '+', '0': '0', '-': '-', '--': '--', '＋＋': '++', '＋': '+', '－': '-', '－－': '--', '−': '-', '−−': '--' };

/** 판정 기호(++, +, 0, -, --)면 표준 기호, 아니면 '' */
export function normGrade(v) {
    return GRADE_ALIASES[String(v ?? '').trim()] || '';
}

/**
 * 상태 변경 하나를 적용.
 * @param {object} [ctx] 게임 모드의 판정형 호감도 규칙 { rules, turnDeltas }
 *   rules: { grades, gain(name), loss(name), speed, slow(value), cap, window, history }
 *   판정(++~--)은 grades × 기질 배율 × 속도로 바꾸고, 최근 window턴 합계가 ±cap을 넘지 않게 자른다.
 *   게임 모드에서는 AI가 숫자를 직접 지정(64 같은 절대값)해도 무시한다.
 */
export function applyStatus(state, items, upd, ctx = null) {
    const item = items.find(it => itemKey(it) === upd.key || it.label === upd.key);
    if (!item) return;
    const k = itemKey(item);
    if (item.type === 'mind') {
        if (!upd.name) return;
        (state.mind[k] || (state.mind[k] = {}))[upd.name] = upd.value;
        return;
    }
    if (item.type !== 'gauge') {
        state.text[k] = upd.value;
        return;
    }
    const name = item.perChar ? (upd.name || '') : '_';
    if (item.perChar && !name) return;
    const bag = state.gauge[k] || (state.gauge[k] = {});
    const rules = item.perChar ? ctx?.rules : null;
    // 처음 판정받는 캐릭터의 시작 값 (시작 관계를 고른 채팅은 "아직 안 만남" → 첫 단계에서 시작)
    const prev = bag[name] ?? rules?.start ?? GAUGE_DEFAULT;
    const grade = normGrade(upd.value);
    if (rules && grade) {
        const base = rules.grades[grade] ?? 0;
        const mult = base > 0 ? rules.gain(name) : base < 0 ? rules.loss(name) : 0;
        // 오를 때만: 지금 단계가 높을수록 덜 오른다 (떨어질 때는 그대로)
        const slow = base > 0 && rules.slow ? rules.slow(prev) : 1;
        let d = base * mult * (rules.speed || 1) * slow;
        // 소수 첫째 자리까지 쌓는다 (느린 캐릭터도 조금씩은 오르고, 기질 차이가 후반에도 남게)
        d = Math.round(d * 10) / 10;
        const recent = (rules.history.get(`${k}.${name}`) || []).reduce((a, b) => a + b, 0) + (ctx.turnDeltas.get(`${k}.${name}`) || 0);
        d = Math.max(-rules.cap - recent, Math.min(rules.cap - recent, d));
        ctx.turnDeltas.set(`${k}.${name}`, (ctx.turnDeltas.get(`${k}.${name}`) || 0) + d);
        bag[name] = Math.max(0, Math.min(100, Math.round((prev + d) * 10) / 10));
        return;
    }
    const m = String(upd.value).match(/^([+-])?\s*(\d+(?:\.\d+)?)$/);
    if (!m) return;
    if (rules && !m[1]) return;
    const n = Number(m[2]);
    bag[name] = clampGauge(m[1] === '+' ? prev + n : m[1] === '-' ? prev - n : n);
}

/** 유저가 직접 고친 값 (절대값) 적용 */
export function applyOverride(state, items, ov) {
    if (!ov) return;
    for (const [k, v] of Object.entries(ov.text || {})) {
        if (k in state.text) state.text[k] = v;
    }
    for (const [k, names] of Object.entries(ov.gauge || {})) {
        if (!(k in state.gauge)) continue;
        for (const [name, v] of Object.entries(names)) state.gauge[k][name] = clampGauge(Number(v));
    }
    for (const [k, names] of Object.entries(ov.mind || {})) {
        if (!(k in (state.mind || {}))) continue;
        Object.assign(state.mind[k], names);
    }
}

/**
 * 턴마다 상태를 앞에서부터 누적 계산한다. initial은 시작 마법사의 시작 관계 등 초기값.
 * 스냅샷을 따로 저장하지 않으므로 편집·삭제·스와이프에 자동으로 맞춰진다.
 */
export function foldStates(turns, items, initial = null, rules = null) {
    const state = emptyState(items);
    applyOverride(state, items, initial);
    if (rules) rules.history = new Map();
    for (const turn of turns) {
        const ctx = rules ? { rules, turnDeltas: new Map() } : null;
        for (const upd of turn.pp.status) applyStatus(state, items, upd, ctx);
        if (rules) {
            // 최근 window턴의 변화만 기억해 상한 계산에 쓴다
            for (const [key, d] of ctx.turnDeltas) {
                const h = rules.history.get(key) || [];
                h.push(d);
                if (h.length > rules.window - 1) h.shift();
                rules.history.set(key, h);
            }
            turn.affinityDeltas = Object.fromEntries(ctx.turnDeltas);
        }
        applyOverride(state, items, turn.override);
        turn.state = structuredClone(state);
    }
    return state;
}

// 픽플레이 - 화면 엔진 (실리태번 비의존)
// 턴 데이터를 받아 그리기만 한다. 실리태번과의 연결은 index.js(어댑터)가 맡는다.

import { itemKey } from './parse.js';
import { THUMB_THRESHOLD, getThumb, cachedThumb } from './thumbs.js';

const STAGE_W = 1280;
const STAGE_H = 720;
const PORTRAIT_W = 600;
/** 세로 배치의 최소 높이: 태블릿처럼 덜 길쭉한 세로 창에서 글자·선택지가 너무 커져 위로 넘치지 않게 */
const PORTRAIT_H = 1100;
/** 속마음 맨 앞 카오모지: (괄호 묶음) 앞뒤로 붙은 기호까지. 한글·한자·영문·숫자가 나오면 본문 */
const KAOMOJI_RE = /^([^\s\p{Script=Hangul}\p{Script=Han}A-Za-z0-9]*[(（][^)）]*[)）][^\s\p{Script=Hangul}\p{Script=Han}A-Za-z0-9.…]*)\s*([\s\S]*)$/u;
/** 바깥 메뉴 버튼 수(⋯ 제외)와 기본 버튼 */
export const MENU_OUTER_COUNT = 3;
export const MENU_OUTER_DEFAULT = ['skip', 'log', 'cg'];

/** 한국어가 아닌 문장인가 (글자 중 한글이 30% 미만). 번역 아이콘을 보일지 정할 때만 쓴다 */
export function isForeign(text) {
    const letters = String(text || '').match(/\p{L}/gu) || [];
    if (letters.length < 2) return false;
    const hangul = letters.filter(c => /[가-힣ㄱ-ㆎ]/.test(c)).length;
    return hangul / letters.length < 0.3;
}

/** 작은 선 아이콘 (LOG 줄 버튼 등). 글자 대신 쓰고, 이름은 버튼의 title·aria-label로 */
const ICONS = {
    doc: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
};
function icon(name, size = 16) {
    const s = document.createElement('span');
    s.className = 'pp-ico';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return s;
}

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

export class PPEngine {
    /**
     * @param {HTMLElement} host
     * @param {object} opts
     *  items, typingMs, autoMs,
     *  onSend(text), onReroll(), onSwipe(dir), onEdit({kind,key,name,value}),
     *  onFav(turn), onExit(), getRegistered() -> string[]
     */
    constructor(host, opts) {
        this.host = host;
        this.o = opts;
        this.items = opts.items || [];
        this.turns = [];
        this.s = {
            view: -1, page: 0, chars: 0, auto: false, hidden: false, overlay: null,
            textTurn: 0, affMode: {}, editing: null, generating: false,
        };
        this.saved = null;
        this.wait = 0;
        this.lastFxKey = '';
        this.build();
        this.iv = setInterval(() => this.tick(), this.o.typingMs || 40);
        this.onKey = (e) => this.handleKey(e);
        document.addEventListener('keydown', this.onKey, true);
        this.ro = new ResizeObserver(() => this.fit());
        this.ro.observe(this.root);
    }

    destroy() {
        clearInterval(this.iv);
        clearTimeout(this.toastTimer);
        document.removeEventListener('keydown', this.onKey, true);
        this.ro.disconnect();
        this.thumbObserver?.disconnect();
        this.root.remove();
    }

    // ───────── 외부 입력 ─────────

    setItems(items) {
        this.items = items;
        this.renderStatus();
    }

    /** follow: 'latest' = 새 턴으로 이동, 'keep' = 보던 위치 유지 */
    setTurns(turns, follow = 'keep') {
        const prevLen = this.turns.length;
        this.turns = turns;
        const CUR = turns.length - 1;
        if (follow === 'latest' || this.s.view < 0 || this.s.view > CUR || (prevLen === 0 && CUR >= 0)) {
            this.saved = null;
            this.s.view = CUR;
            // 지난번에 이 턴을 읽다 나갔으면 그 문장부터 (새 답장·다른 스와이프면 처음부터)
            const resume = CUR >= 0 ? Number(this.o.resumePage?.(turns[CUR])) || 0 : 0;
            this.s.page = Math.max(0, Math.min(resume, (turns[CUR]?.lines.length || 1) - 1));
            this.s.chars = 0;
            this.s.editing = null;
        } else {
            const L = this.lines();
            if (this.s.page > L.length - 1) { this.s.page = Math.max(0, L.length - 1); this.s.chars = 0; }
        }
        this.renderAll();
    }

    /** 마법사·로딩처럼 진행을 막는 창. null이면 닫는다 */
    setModal(node) {
        this.s.modal = !!node;
        this.el.modal.replaceChildren(...(node ? [node] : []));
        this.el.modal.hidden = !node;
    }

    setGenerating(on) {
        if (this.s.generating === on) return;
        this.s.generating = on;
        this.renderDialogue();
        this.renderChoices();
        this.renderMenu();
        if (!on && this.overlayDirty) {
            this.overlayDirty = false;
            if (this.s.overlay) this.renderOverlay(true);
        }
        this.maybeReady();
    }

    /** 답장 생성이 끝나고 번역 대기도 끝나 실제로 읽을 수 있게 된 순간 한 번 알린다 (알림음) */
    maybeReady() {
        if (this.s.generating) { this.readyArmed = true; return; }
        if (this.readyArmed && !this.waitingTrans) { this.readyArmed = false; this.o.onReady?.(); }
    }

    /** 번역 확장이 지금 턴을 번역하는 동안 대사 대신 "번역 중"을 보여준다. 시간 제한 없음 */
    setTranslating(on) {
        on = !!on;
        if (this.s.translating === on) return;
        this.s.translating = on;
        if (on) { this.s.page = 0; this.s.chars = 0; this.s.auto = false; }
        this.renderDialogue();
        this.renderChoices();
        this.renderMenu();
        this.maybeReady();
    }

    // ───────── 내부 계산 ─────────

    get CUR() { return this.turns.length - 1; }
    get replay() { return this.s.view >= 0 && this.s.view !== this.CUR; }
    get waitingTrans() { return !!this.s.translating && !this.replay; }
    turn(i = this.s.view) { return this.turns[i] || null; }
    lines(i = this.s.view) { return this.turn(i)?.lines || []; }
    line() { return this.lines()[this.s.page] || { n: '', t: '' }; }
    typed() { return this.s.chars >= this.line().t.length; }
    atEnd() { return this.s.page >= this.lines().length - 1; }

    cgFor(i) {
        const t = this.turns[i];
        // 한 답장에 그림이 여러 장이면, 글에서 그림이 놓인 문장에 도달할 때마다 바꿔 보여 준다 (그 전에는 첫 그림)
        if (t?.cgSeq && i === this.s.view) {
            const L = t.lines;
            let k = -1;
            for (let p = 0; p <= this.s.page && p < L.length; p++) if (L[p].cgAt != null) k = L[p].cgAt;
            if (k < 0) k = Math.min(...L.filter(l => l.cgAt != null).map(l => l.cgAt), 0);
            if (t.cgs[k]) return t.cgs[k];
        }
        for (let k = i; k >= 0; k--) if (this.turns[k]?.cg) return this.turns[k].cg;
        return '';
    }

    meta(turn) {
        if (!turn?.state) return '';
        return this.items.filter(it => it.type !== 'gauge' && it.type !== 'mind').slice(0, 2)
            .map(it => turn.state.text[itemKey(it)]).filter(Boolean).join(' · ');
    }

    // ───────── 진행 ─────────

    tick() {
        const s = this.s;
        if (s.hidden || s.overlay || s.modal || s.generating || this.waitingTrans || !this.host.isConnected) return;
        const t = this.line().t;
        if (s.chars < t.length) {
            this.wait = 0;
            s.chars++;
            this.renderText();
            if (s.chars >= t.length) { this.renderProgress(); this.renderChoices(); }
            return;
        }
        // 회상 중 AUTO는 턴 끝에서 다음 턴으로 이어 간다
        if (s.auto && (!this.atEnd() || this.replay)) {
            this.wait += this.o.typingMs || 40;
            if (this.wait >= this.autoWait(t)) this.advance();
        }
    }

    /** 이번 턴에서 지금까지 읽은 가장 먼 문장. 뒤로 갔다 다시 넘길 때는 타이핑·효과 없이 바로 보여준다 */
    readUpTo() {
        const t = this.turn();
        const key = `${this.s.view}:${t?.mesId}:${t?.swipeId}`;
        if (this.readKey !== key) { this.readKey = key; this.readMax = this.s.page; }
        return this.readMax;
    }

    /**
     * AUTO에서 다음 문장으로 넘어가기까지 기다리는 시간. 문장이 길수록 오래 기다린다.
     * 기준값(설정의 AUTO 대기)의 60%를 기본으로 하고 글자당 40ms를 더하되, 기준값의 3배를 넘지 않는다.
     */
    autoWait(text) {
        const base = this.o.autoMs || 1500;
        return Math.min(base * 3, Math.max(600, base * 0.6) + String(text || '').length * 40);
    }

    /** 설정의 타이핑 속도(한 글자당 ms)·AUTO 대기(ms)를 화면을 다시 만들지 않고 바꾼다 */
    setTiming({ typingMs, autoMs } = {}) {
        if (autoMs) this.o.autoMs = autoMs;
        if (typingMs && typingMs !== this.o.typingMs) {
            this.o.typingMs = typingMs;
            clearInterval(this.iv);
            this.iv = setInterval(() => this.tick(), typingMs);
        }
    }

    /** 글자 크기·대사창 불투명도·메인 색(#rrggbb) */
    applyLook({ fontSize, windowAlpha, accent } = {}) {
        if (fontSize) this.root.style.setProperty('--pp-text-size', `${fontSize}px`);
        if (windowAlpha != null) this.root.style.setProperty('--pp-win-alpha', String(windowAlpha));
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(accent || ''));
        if (m) {
            this.root.style.setProperty('--pp-accent', accent);
            this.root.style.setProperty('--pp-accent-rgb', m.slice(1).map(x => parseInt(x, 16)).join(' '));
        }
        // 스피커는 알약 색을 복사해 두니, 색·진하기가 바뀌면 다시 따라간다
        this.renderSoundBtn?.();
    }

    goPage(p) {
        this.wait = 0;
        const reread = p <= this.readUpTo();
        this.s.page = p;
        this.readMax = Math.max(this.readMax, p);
        this.s.chars = reread ? this.line().t.length : 0;
        this.renderDialogue();
        this.renderChoices();
    }

    advance() {
        if (this.s.modal || (this.s.generating && !this.replay) || this.waitingTrans) return;
        if (!this.typed()) {
            this.s.chars = this.line().t.length;
            this.renderText();
            this.renderProgress();
            this.renderChoices();
            return;
        }
        if (!this.atEnd()) this.goPage(this.s.page + 1);
        else if (this.replay) this.startReplay(this.s.view + 1, { keepAuto: true });
    }

    /** 이전 문장으로 (현재 턴 안에서). 돌아간 문장은 타이핑 없이 전체를 보여준다 */
    back() {
        if (this.s.modal || this.s.overlay || (this.s.generating && !this.replay)) return;
        if (this.s.page <= 0) {
            // 이미 첫 문장이면 지금 문장만 다 보여준다
            if (!this.typed()) { this.s.chars = this.line().t.length; this.renderText(); this.renderProgress(); return; }
            // 첫 문장에서 더 돌아가면 이전 턴의 마지막 문장으로 (현재 턴이었으면 회상으로 들어간다)
            if (this.s.view > 0) {
                if (!this.replay) { this.saved = { page: this.s.page, chars: this.s.chars }; this.s.auto = false; }
                this.s.view -= 1;
                const L = this.lines();
                this.s.page = Math.max(0, L.length - 1);
                this.s.chars = L[this.s.page]?.t.length || 0;
                this.readUpTo();
                this.readMax = this.s.page;
                // 다 읽은 문장으로 돌아가는 것이라 효과·장면 전환은 다시 재생하지 않는다
                this.skipTransition = true;
                this.renderAll();
            }
            return;
        }
        this.wait = 0;
        this.readUpTo();
        this.s.page -= 1;
        this.s.chars = this.line().t.length;
        this.renderDialogue();
        this.renderChoices();
    }

    skip() {
        const L = this.lines();
        if (!L.length) return;
        this.readUpTo();
        this.readMax = L.length - 1;
        this.s.page = L.length - 1;
        this.s.chars = L[L.length - 1].t.length;
        this.renderDialogue();
        this.renderChoices();
    }

    /** idx 턴부터 다시 본다. 턴 끝에서 넘기면 다음 턴으로 이어지고, 마지막 턴에 닿으면 현재로 돌아온다 */
    startReplay(idx, { keepAuto = false, cg = '' } = {}) {
        // LOG·TEXT·CG 뷰어 어디서 왔든 패널을 닫고 VN 화면으로
        this.closeOverlay();
        if (!keepAuto) this.s.auto = false;
        this.wait = 0;
        this.s.editing = null;
        if (idx === this.CUR) {
            this.saved = null;
        } else if (!this.replay) {
            this.saved = { page: this.s.page, chars: this.s.chars };
        }
        this.s.view = idx;
        this.s.page = 0;
        this.s.chars = 0;
        // 그림이 여러 장인 턴을 CG 뷰어에서 골랐으면 그 그림이 나오는 문장부터
        if (cg && this.turns[idx]?.cgSeq) {
            const n = this.lines(idx).length;
            for (let p = 0; p < n; p++) { this.s.page = p; if (this.cgFor(idx) === cg) break; }
            if (this.cgFor(idx) !== cg) this.s.page = 0;
        }
        this.lastFxKey = '';
        this.renderAll();
    }

    backToNow() {
        const L = this.lines(this.CUR);
        const sv = this.saved || { page: Math.max(0, L.length - 1), chars: L[L.length - 1]?.t.length || 0 };
        this.saved = null;
        this.s.view = this.CUR;
        this.s.page = sv.page;
        this.s.chars = sv.chars;
        this.s.auto = false;
        this.lastFxKey = 'skip';
        this.skipTransition = true;
        this.renderAll();
    }

    /**
     * 보내기. 빈칸이면 내 말 없이 AI가 이어서 쓴다.
     * "전개 지시" 칸에 적힌 내용은 이번 답장 한 번에만 지시로 붙고 비워진다.
     */
    send(text) {
        if (this.s.generating) return;
        const v = String(text || '').trim();
        const dir = String(this.el.dir?.value || '').trim();
        this.o.onSend?.(v, dir);
        if (this.el.dir) { this.el.dir.value = ''; this.toggleDir(false); }
    }

    /** 선택지 고르기: 바로 보내지 않고 입력칸에 넣는다 (고쳐 쓰거나 원문으로 바꿔 보낼 수 있게). 보내기·Enter로 전송 */
    pickChoice(text) {
        const f = this.el.free;
        f.value = String(text || '');
        f.focus();
        f.setSelectionRange(f.value.length, f.value.length);
    }

    /** "전개 지시" 칸 열기/닫기 */
    toggleDir(open = this.el.dirRow.hidden) {
        this.el.dirRow.hidden = !open;
        this.el.dirToggle.classList.toggle('pp-on', open || !!this.el.dir.value.trim());
        this.el.dirToggle.setAttribute('aria-expanded', String(open));
        if (open) setTimeout(() => this.el.dir.focus(), 0);
    }

    /** 되돌린 뒤: 이전 턴 끝(선택지·입력칸)으로 가서 내 말을 입력칸에 넣는다 */
    restoreDraft(text) {
        if (this.s.view !== this.CUR) this.backToNow();
        this.skip();
        this.el.free.value = text || '';
        setTimeout(() => { this.el.free.focus(); this.el.free.setSelectionRange(this.el.free.value.length, this.el.free.value.length); }, 50);
    }

    /** ⋯ → 테마: 네 테마 중 고르면 바로 바뀌고 설정에도 저장된다 */
    toggleTheme(open = !this.s.themeOpen) {
        this.s.themeOpen = open;
        const panel = this.el.themePanel;
        panel.hidden = !open;
        this.el.mTheme.classList.toggle('pp-on', open);
        if (!open) { panel.replaceChildren(); return; }
        if (this.s.qrOpen) this.toggleQr(false);
        const names = { box: '클래식', retro: '미연시', sub: '서브컬처', cinema: '시네마' };
        panel.replaceChildren(...Object.entries(names).map(([v, label]) => h('button', {
            class: 'pp-qr-btn' + (this.style === v ? ' pp-on' : ''), text: label, 'aria-pressed': String(this.style === v),
            onclick: () => { this.toggleTheme(false); this.o.onTheme?.(v); },
        })));
    }

    /** QR 판 열기/닫기. 열 때마다 실리태번의 지금 QR 목록을 다시 읽는다 */
    toggleQr(open = !this.s.qrOpen) {
        const list = open ? (this.o.getQuickReplies?.() || []) : [];
        this.s.qrOpen = open && list.length > 0;
        const panel = this.el.qrPanel;
        panel.hidden = !this.s.qrOpen;
        this.el.mQr.classList.toggle('pp-on', this.s.qrOpen);
        if (!this.s.qrOpen) { panel.replaceChildren(); return; }
        // QR 세트가 바뀌는 곳에서 줄을 나눈다
        const nodes = [];
        list.forEach((q, i) => {
            if (i > 0 && q.group !== list[i - 1].group) nodes.push(h('span', { class: 'pp-qr-sep', 'aria-hidden': 'true' }));
            const b = h('button', { class: 'pp-qr-btn', title: q.title || q.label, onclick: () => { this.toggleQr(false); this.o.onQuickReply?.(i, q); } });
            if (q.icon) b.append(h('i', { class: `fa-solid ${q.icon}`, 'aria-hidden': 'true' }));
            if (q.label) b.append(h('span', { text: q.label }));
            nodes.push(b);
        });
        panel.replaceChildren(...nodes);
    }

    /** ⋯ 판 열기/닫기 (AUTO · TEXT · TRANS · HIDE · QR · 채팅 설정) */
    toggleMore(open = !this.s.moreOpen) {
        this.s.moreOpen = open;
        if (open && this.s.qrOpen) this.toggleQr(false);
        if (open && this.s.themeOpen) this.toggleTheme(false);
        this.el.morePanel.hidden = !open;
        this.renderMenu();
    }

    flash(msg) {
        clearTimeout(this.toastTimer);
        this.el.toast.textContent = msg;
        this.el.toast.hidden = false;
        this.toastTimer = setTimeout(() => { this.el.toast.hidden = true; }, 2800);
    }

    handleKey(e) {
        if (!this.host.isConnected || this.root.offsetParent === null) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
        if (this.s.modal) return;
        // 입력칸 안의 Esc는 그 입력칸이 처리한다 (상태 수정 취소 등)
        if (e.key === 'Escape' && typing) return;
        if (e.key === 'Escape') {
            if (this.s.overlay === 'viewer') { e.preventDefault(); e.stopPropagation(); this.closeViewer(); }
            else if (this.s.overlay) { e.preventDefault(); e.stopPropagation(); this.backOrClose(); }
            else if (this.s.moreOpen) { e.preventDefault(); e.stopPropagation(); this.toggleMore(false); }
            else if (this.s.qrOpen) { e.preventDefault(); e.stopPropagation(); this.toggleQr(false); }
            else if (this.s.themeOpen) { e.preventDefault(); e.stopPropagation(); this.toggleTheme(false); }
            else if (this.s.statusOpen) { e.preventDefault(); e.stopPropagation(); this.toggleStatus(false); }
            else if (this.s.hidden) { e.preventDefault(); this.setHidden(false); }
            else { e.preventDefault(); e.stopPropagation(); this.o.onExit?.(); }
            return;
        }
        // CG 뷰어: ← → 다른 턴의 그림, ↑ ↓ 같은 턴의 다른 버전
        if (this.s.overlay === 'viewer' && !typing) {
            const map = { ArrowLeft: () => this.viewerMove(-1), ArrowRight: () => this.viewerMove(1), ArrowUp: () => this.viewerVersion(-1), ArrowDown: () => this.viewerVersion(1) };
            if (map[e.key]) { e.preventDefault(); e.stopPropagation(); map[e.key](); }
            return;
        }
        if (typing || this.s.overlay || e.ctrlKey || e.altKey || e.metaKey) return;
        // 단축키 (한글 입력 상태에서도 되게 자판 위치로 본다): L 로그 · A 자동 · S 스킵 · H 숨기기
        const keyAct = { KeyL: () => this.openOverlay('log'), KeyA: () => this.el.mAuto.click(), KeyS: () => this.skip(), KeyH: () => this.setHidden(!this.s.hidden) }[e.code];
        if (keyAct && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            keyAct();
            return;
        }
        // 선택지 번호 키
        if (/^[1-4]$/.test(e.key) && this.choicesVisible() && !this.s.hidden) {
            const c = this.o.choicesOn?.() === false ? null : this.turn()?.pp?.choices?.[Number(e.key) - 1];
            if (c) { e.preventDefault(); e.stopPropagation(); this.pickChoice(c); }
            return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
            e.preventDefault();
            e.stopPropagation();
            this.back();
            return;
        }
        // → 는 다음 문장. 실리태번의 → (스와이프·리롤)로 넘어가지 않게 여기서 막는다. 리롤은 REROLL 버튼으로만
        if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'PageDown') {
            e.preventDefault();
            e.stopPropagation();
            if (this.s.hidden) this.setHidden(false);
            else this.advance();
        }
    }

    setHidden(on) {
        this.s.hidden = on;
        this.root.classList.toggle('pp-hidden', on);
    }

    // ───────── 화면 골격 ─────────

    build() {
        const el = this.el = {};
        el.cgA = h('img', { class: 'pp-cg-img', alt: '' });
        el.cgB = h('img', { class: 'pp-cg-img', alt: '' });
        el.cgEmpty = h('div', { class: 'pp-cg-empty', text: 'CG 없음' });
        el.cg = h('div', { class: 'pp-cg' }, el.cgEmpty, el.cgA, el.cgB);
        el.cgBg = h('div', { class: 'pp-cg-bg', 'aria-hidden': 'true' });
        el.fx = h('div', { class: 'pp-fx' });

        el.banner = h('div', { class: 'pp-pill pp-banner', hidden: true });
        el.infoValues = h('span', { class: 'pp-info-values' });
        el.infoChevron = h('span', { class: 'pp-info-chevron', 'aria-hidden': 'true' });
        el.infoChevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
        // 서브컬처 테마에서는 대사창 안(이름 위)으로 옮겨지므로, 대사창 클릭(다음)으로 번지지 않게 막는다
        el.info = h('button', {
            class: 'pp-pill pp-info', hidden: true, 'aria-expanded': 'false', title: '상태 펼치기',
            onclick: (e) => { e.stopPropagation(); this.toggleStatus(); },
        }, el.infoValues, el.infoChevron);
        el.statusDrop = h('div', { class: 'pp-status-drop', hidden: true, role: 'region', 'aria-label': '상태' });
        el.affToast = h('div', { class: 'pp-pill pp-aff-toast', role: 'status', hidden: true });

        el.choiceList = h('div', { class: 'pp-choice-list' });
        el.free = h('input', { type: 'text', class: 'pp-free', autocomplete: 'off', placeholder: '직접 입력', 'aria-label': '직접 입력' });
        el.free.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.send(el.free.value); el.free.value = ''; }
        });
        el.freeSend = h('button', { class: 'pp-free-send', text: '보내기', onclick: () => { this.send(el.free.value); el.free.value = ''; } });
        // 펜 아이콘 = "전개 지시" 칸 열기 (이번 답장 한 번에만 붙는다)
        el.dirToggle = h('button', { class: 'pp-free-icon pp-dir-toggle', title: '전개 지시', 'aria-label': '전개 지시', 'aria-expanded': 'false',
            onclick: (e) => { e.stopPropagation(); this.toggleDir(); } });
        el.dirToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
        el.dir = h('input', { type: 'text', class: 'pp-dir', autocomplete: 'off', 'aria-label': '전개 지시' });
        el.dir.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.send(el.free.value); el.free.value = ''; }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.toggleDir(false); }
        });
        // 칸을 닫아도 적힌 지시가 있으면 펜을 강조해 둔다 (지우면 강조도 끈다)
        el.dir.addEventListener('input', () => el.dirToggle.classList.toggle('pp-on', !el.dirRow.hidden || !!el.dir.value.trim()));
        el.dirRow = h('div', { class: 'pp-dir-row', hidden: true },
            h('span', { class: 'pp-dir-tag', text: '전개 지시' }), el.dir,
            h('button', { class: 'pp-dir-clear', title: '지우기', 'aria-label': '전개 지시 지우기', text: '×',
                onclick: () => { el.dir.value = ''; this.toggleDir(false); } }));
        el.choices = h('div', { class: 'pp-choices', hidden: true }, el.choiceList, h('div', { class: 'pp-free-row' }, el.dirToggle, el.free, el.freeSend), el.dirRow);

        el.speaker = h('span', { class: 'pp-speaker' });
        el.speakerRow = h('span', { class: 'pp-speaker-row' }, el.speaker, h('span', { class: 'pp-speaker-line' }));
        el.text = h('span', { class: 'pp-text' });
        el.progFill = h('span', { class: 'pp-prog-fill' });
        el.progCount = h('span', { class: 'pp-prog-count' });
        el.next = h('span', { class: 'pp-next', 'aria-hidden': 'true' });
        el.next.innerHTML = '<svg width="12" height="9" viewBox="0 0 12 9"><path d="M1 1h10L6 8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        // 대사창 전체가 "다음"이고, 안쪽 ‹ 버튼만 "이전". 버튼을 품어야 해서 대사창은 div로 둔다
        // 답변 조작(‹ 다시 쓰기 ›)은 대사창 오른쪽 위. 대사창 클릭(다음)으로 번지지 않게 막는다
        const ab = (cls, label, fn) => h('button', { class: `pp-ans-btn ${cls}`, 'aria-label': label, title: label,
            onclick: (e) => { e.stopPropagation(); fn(); } });
        el.mPrev = ab('pp-ans-side', '이전 스와이프', () => this.o.onSwipe?.('left'));
        el.mPrev.textContent = '‹';
        el.mReroll = ab('pp-ans-main', '답변 다시 쓰기', () => this.o.onReroll?.());
        el.mReroll.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        el.mNext = ab('pp-ans-side', '다음 스와이프', () => this.o.onSwipe?.('right'));
        el.mNext.textContent = '›';
        // 휴지통: 이 턴(내 말 + 답장)을 지우고 내 말을 입력칸에 돌려놓는다 (확인 한 번)
        el.mUndo = ab('pp-ans-undo', '이 턴 지우기 (내 메세지와 답변 삭제)', () => this.o.onUndo?.());
        el.mUndo.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        // 번역: 지금 문장이 한국어가 아닐 때만 휴지통 옆에 작게
        el.mTl = ab('pp-ans-tl', '번역 보기', () => { const t = this.turn(); if (t) this.o.onTranslate?.(t); });
        el.mTl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h8M8 3v2M10 5c-1 4-3 7-6 9M6 9c1 2 3 4 5 5M13 21l4-9 4 9M14.5 18h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        el.ansGap = h('span', { class: 'pp-ans-gap', 'aria-hidden': 'true' });
        el.answer = h('span', { class: 'pp-answer' }, el.mTl, el.mUndo, el.ansGap, el.mPrev, el.mReroll, el.mNext);
        // 번역을 기다리는 동안만 보이는 "원문으로 보기"
        el.mOrig = h('button', { class: 'pp-orig-btn pp-wait-btn', hidden: true, text: '원문으로 보기',
            onclick: (e) => { e.stopPropagation(); const t = this.turn(); if (t) this.o.onShowOriginal?.(t); } });
        // 문장 이동: 진행 표시와 한 알약에 [‹ ── 2/3 ›]
        el.mBack = h('button', { class: 'pp-line-nav pp-line-prev', title: '이전 문장 (← 키)', 'aria-label': '이전 문장', text: '‹',
            onclick: (e) => { e.stopPropagation(); this.back(); } });
        el.mFwd = h('button', { class: 'pp-line-nav pp-line-next', title: '다음 문장 (→ · Space 키)', 'aria-label': '다음 문장', text: '›',
            onclick: (e) => { e.stopPropagation(); this.advance(); } });
        el.mStop = h('button', { class: 'pp-orig-btn pp-wait-btn pp-stop-btn', hidden: true, text: '■ 생성 중단', title: '지금 쓰고 있는 답장 생성을 멈춰요',
            onclick: (e) => { e.stopPropagation(); this.o.onStop?.(); } });
        el.dialogue = h('div', { class: 'pp-dialogue', role: 'button', 'aria-label': '다음 대사로', onclick: () => this.advance() },
            el.answer, el.speakerRow, el.text,
            h('span', { class: 'pp-progress' },
                h('span', { class: 'pp-nav-pill' }, el.mBack, h('span', { class: 'pp-prog-bar' }, el.progFill), el.progCount, el.mFwd), el.next));

        const mb = (label, title, fn) => h('button', { class: 'pp-menu-btn', title, text: label, onclick: fn });
        // ⋯ 안의 항목: 누르면 ⋯ 판을 닫고 실행
        const mm = (label, title, fn) => mb(label, title, (e) => { e.stopPropagation(); this.toggleMore(false); fn(); });
        el.mAuto = mm('AUTO', '자동 진행', () => { this.wait = 0; this.s.auto = !this.s.auto; this.renderMenu(); });
        el.mSkip = mb('SKIP', '이 턴 끝까지 넘기기', () => this.skip());
        el.mLog = mb('LOG', '지난 턴 기록', () => this.openOverlay('log'));
        el.mText = mm('TEXT', '이 턴 전체 답변 보기', () => this.openText(Math.max(0, this.s.view)));
        el.mHide = mm('HIDE', 'UI 숨기기', () => this.setHidden(true));
        el.mCg = mb('CG ↻', '지금 보이는 턴의 그림 다시 생성', () => {
            const t = this.turn();
            if (!t) return;
            // 그림이 여러 장인 턴은 지금 보이는 그림을 다시 그린다
            this.o.onRerollCg?.(t, this.cgFor(this.s.view));
            this.flash('그림을 다시 생성해요');
        });
        // BGM·효과음 켜고 끄기: 상태 알약 옆 스피커. 설정에서 켰고 폴더에 파일이 있을 때만 보인다
        el.soundBtn = h('button', {
            class: 'pp-pill pp-sound-btn', hidden: true,
            onclick: (e) => {
                e.stopPropagation();
                this.o.onToggleSound?.();
                this.renderMenu();
                this.flash(this.o.soundOn?.() ? 'BGM·효과음을 켰어요' : 'BGM·효과음을 껐어요');
            },
        });
        // QR: 실리태번 퀵리플라이 버튼을 메뉴 위 작은 판으로 보여준다
        el.mQr = mm('QR', '퀵 리플라이', () => this.toggleQr());
        el.qrPanel = h('div', { class: 'pp-qr-panel', hidden: true, onclick: (e) => e.stopPropagation() });
        // 테마: QR 판과 같은 자리에 네 테마 버튼
        el.mTheme = mm('THEME', '화면 테마 바꾸기', () => this.toggleTheme());
        el.themePanel = h('div', { class: 'pp-qr-panel pp-theme-panel', hidden: true, onclick: (e) => e.stopPropagation() });
        el.mChat = mm('STATUS', '이 채팅 상태창 (항목 · 캐릭터 명단 · 공략 정보)', () => this.o.onChatSettings?.());
        el.mExit = mb('EXIT', '픽플레이 끄기', () => this.o.onExit?.());
        // 자주 쓰는 SKIP · LOG · CG만 밖에, 나머지는 ⋯ 안에. EXIT는 모바일에서도 바로 누를 수 있게 늘 밖에
        el.mMore = mb('⋯', '더보기', (e) => { e.stopPropagation(); this.toggleMore(); });
        el.mMore.classList.add('pp-more-btn');
        el.morePanel = h('div', { class: 'pp-more-panel', hidden: true, onclick: (e) => e.stopPropagation() },
            el.mAuto, el.mText, el.mHide, el.mQr, el.mChat);
        el.menuMain = h('div', { class: 'pp-menu-group' }, el.mSkip, el.mLog, el.mCg, el.mMore);
        el.menu = h('div', { class: 'pp-menu' }, el.menuMain, h('div', { class: 'pp-menu-group' }, el.mExit));
        // ⋯ 안으로 들어간 SKIP·LOG·CG도 누르면 판이 닫히게
        el.morePanel.addEventListener('click', (e) => { if (e.target.closest('button')) this.toggleMore(false); });
        this.setMenuOuter(this.o.menuOuter);

        el.toast = h('div', { class: 'pp-pill pp-toast', hidden: true });
        el.overlay = h('div', { class: 'pp-overlay', hidden: true, onclick: (e) => { if (e.target === el.overlay) this.backOrClose(); } });
        el.unhide = h('button', { class: 'pp-unhide', 'aria-label': 'UI 다시 보기', onclick: () => this.setHidden(false) },
            h('span', { text: '화면을 누르면 UI가 다시 나타나요' }));

        el.ui = h('div', { class: 'pp-ui' },
            h('div', { class: 'pp-scrim', 'aria-hidden': 'true' }),
            h('div', { class: 'pp-scrim-top', 'aria-hidden': 'true' }),
            el.info, el.soundBtn, el.statusDrop, el.affToast, el.banner, el.choices, el.dialogue, el.menu, el.mStop, el.mOrig, el.morePanel, el.qrPanel, el.themePanel, el.toast, el.overlay);
        el.modal = h('div', { class: 'pp-overlay pp-modal', hidden: true });
        el.stage = h('div', { class: 'pp-stage' }, el.ui, el.unhide, el.modal);
        // 안전 영역 크기를 재는 보이지 않는 칸 (CSS env(safe-area-inset-*)를 px로 읽는다)
        el.safeProbe = h('div', { class: 'pp-safe-probe', 'aria-hidden': 'true' });
        // 마우스 휠: 위로 = 이전 문장, 아래로 = 다음 문장 (스크롤되는 패널 안에서는 무시)
        el.stage.addEventListener('wheel', (e) => {
            if (this.s.overlay || this.s.modal || this.s.hidden) return;
            if (e.target.closest?.('.pp-scroll, .pp-status-drop, .pp-choices')) return;
            e.preventDefault();
            const now = Date.now();
            if (now - (this.lastWheel || 0) < 180) return;
            this.lastWheel = now;
            if (e.deltaY < 0) this.back();
            else if (e.deltaY > 0) this.advance();
        }, { passive: false });
        el.stage.addEventListener('click', (e) => {
            if (e.target !== el.stage && e.target !== el.ui) return;
            // 상태·QR·⋯이 펼쳐져 있으면 빈 곳 클릭은 접기만 한다
            if (this.s.moreOpen) this.toggleMore(false);
            else if (this.s.qrOpen) this.toggleQr(false);
            else if (this.s.themeOpen) this.toggleTheme(false);
            else if (this.s.statusOpen) this.toggleStatus(false);
            else this.advance();
        });

        this.root = h('div', { class: 'pp-root' }, el.cgBg, el.cg, el.fx, el.stage, el.safeProbe);
        this.setDialogueStyle(this.o.dialogueStyle);
        this.applyLook({ fontSize: this.o.fontSize, windowAlpha: this.o.windowAlpha, accent: this.o.accent });
        this.host.append(this.root);
        this.fit();
    }

    /**
     * 폰의 안전 영역(노치 · 다이나믹 아일랜드 · 홈 바). 실리태번은 viewport-fit=cover라 화면이 그 밑까지 깔린다.
     * 무대(버튼·글자)는 이 안쪽에만 두고, 배경(흐린 CG)은 그대로 끝까지 채운다. PC·안드로이드는 0
     */
    safeInsets() {
        const p = this.el?.safeProbe;
        if (!p) return { t: 0, r: 0, b: 0, l: 0 };
        const cs = getComputedStyle(p);
        return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    }

    /**
     * 1280×720 기준 수치를 유지하면서, 무대 자체는 창 비율에 맞춰 늘린다.
     * 그래서 창이 16:9보다 길거나 넓어도 메뉴는 화면 맨 아래, 정보는 맨 위에 붙는다.
     */
    fit() {
        const ins = this.safeInsets();
        const fullW = this.root.clientWidth || window.innerWidth;
        const fullH = this.root.clientHeight || window.innerHeight;
        // 아래 계산은 안전 영역 안쪽 크기로 하고, 무대·CG 자리는 그만큼 밀어 둔다
        const w = Math.max(1, fullW - ins.l - ins.r);
        const hgt = Math.max(1, fullH - ins.t - ins.b);
        // 세로 화면의 그림 자리도 안전 영역 아래에서 시작하게 CSS에 알려 준다
        this.root.style.setProperty('--pp-inset-top', `${ins.t}px`);
        this.root.style.setProperty('--pp-inset-bottom', `${ins.b}px`);
        if (this.el.stage) {
            this.el.stage.style.left = `${ins.l + w / 2}px`;
            this.el.stage.style.top = `${ins.t + hgt / 2}px`;
        }
        // 배치는 창 모양으로만 정한다: 세로로 긴 창 = 세로 배치(폰), 가로 창 = 가로 배치(PC).
        // 그림 비율로 정하면 그림이 뜨는 순간·가로/세로 그림이 섞일 때마다 배치가 바뀌었다
        const a = this.cgAspect || 0;
        const portrait = hgt > w;
        this.root.classList.toggle('pp-portrait', portrait);
        this.root.classList.toggle('pp-framed', !portrait && a > 0);
        if (portrait) {
            // 세로 창: 화면 전체를 쓰고 CG는 대사 위 공간에 맞춘다 (CSS). 폭 600 기준, 높이 상한(태블릿)
            const sc = Math.min(w / PORTRAIT_W, hgt / PORTRAIT_H);
            this.el.stage.style.width = `${w / sc}px`;
            this.el.stage.style.height = `${hgt / sc}px`;
            this.el.stage.style.transform = `translate(-50%, -50%) scale(${sc})`;
            Object.assign(this.el.cg.style, { left: '', top: '', width: '', height: '', right: '', bottom: '' });
            this.placeChoices();
            this.afterFit();
            return;
        }
        // 가로 창: CG는 창 안에 자르지 않고 맞추고, 남는 칸은 흐린 CG(pp-cg-bg)가 채운다.
        // 글자·버튼 배율은 가로 그림이면 그림 틀, 세로 그림·그림 없음이면 16:9 틀 기준 (세로 그림이어도 글자 크기가 그대로)
        const fitBox = (ratio) => (w / hgt > ratio ? [hgt * ratio, hgt] : [w, w / ratio]);
        const [bw, bh] = fitBox(a >= 1 ? a : STAGE_W / STAGE_H);
        const sc = Math.min(bw / STAGE_W, bh / STAGE_H);
        // 무대: 시네마는 창 전체(띠는 그림 위에 겹친다), 나머지는 배율 기준 틀 (그림이 없으면 창 전체)
        const [sw, sh] = this.style === 'cinema' || !a ? [w, hgt] : [bw, bh];
        this.el.stage.style.width = `${sw / sc}px`;
        this.el.stage.style.height = `${sh / sc}px`;
        this.el.stage.style.transform = `translate(-50%, -50%) scale(${sc})`;
        if (a > 0) {
            const [cw, ch] = fitBox(a);
            Object.assign(this.el.cg.style, { left: `${ins.l + (w - cw) / 2}px`, top: `${ins.t + (hgt - ch) / 2}px`, width: `${cw}px`, height: `${ch}px`, right: 'auto', bottom: 'auto' });
        } else {
            Object.assign(this.el.cg.style, { left: '', top: '', width: '', height: '', right: '', bottom: '' });
        }
        this.placeChoices();
        this.afterFit();
    }

    /** 무대 크기가 바뀐 뒤: 스피커·생성 중단처럼 자리를 재서 두는 것들을 다시 놓는다 */
    afterFit() {
        // 세로 화면 그림은 대사창 위 빈칸에 딱 맞춘다 (대사창 밑으로 그림 아래가 깔리지 않게)
        if (this.root.classList.contains('pp-portrait') && this.el.dialogue?.offsetHeight) {
            const rootTop = this.root.getBoundingClientRect().top;
            const dlgTop = this.el.dialogue.getBoundingClientRect().top - rootTop;
            const top = parseFloat(this.root.style.getPropertyValue('--pp-inset-top')) || 0;
            this.root.style.setProperty('--pp-cg-h', `${Math.max(120, dlgTop - top - 8)}px`);
        }
        this.renderSoundBtn();
        this.placeWaitBtn();
        // 펼친 상태창 높이도 새 크기에 맞춰 대사창 위까지로
        if (this.s?.statusOpen && this.el?.statusDrop) this.renderStatus();
    }

    /**
     * 테마: box(클래식) · retro(레트로) · sub(서브컬처) · cinema(시네마).
     * 클래식·레트로는 창 구조(pp-dlg-box), 서브컬처·시네마는 하단 자막 구조
     */
    setDialogueStyle(style) {
        if (!['box', 'retro', 'sub', 'cinema'].includes(style)) style = 'box';
        this.style = style;
        const c = this.root.classList;
        c.toggle('pp-dlg-box', style === 'box' || style === 'retro');
        c.toggle('pp-t-retro', style === 'retro');
        c.toggle('pp-t-sub', style === 'sub');
        c.toggle('pp-t-cinema', style === 'cinema');
        // 상태 표시는 모든 테마에서 화면 위 (예전에 서브컬처가 대사창 안으로 옮겼던 것을 되돌린다)
        if (this.el.info.parentNode !== this.el.ui) this.el.ui.insertBefore(this.el.info, this.el.statusDrop);
        this.fit();
        // 테마가 바뀌면 알약·메뉴 자리가 바뀌니 스피커·생성 중단 자리도 바로 다시 잰다
        this.renderSoundBtn();
        this.placeWaitBtn();
        requestAnimationFrame(() => { this.renderSoundBtn(); this.placeWaitBtn(); });
    }

    /** 지금 보이는 CG의 가로/세로 비율이 바뀌면 무대를 다시 맞춘다 */
    setCgAspect(a) {
        a = a > 0 && Number.isFinite(a) ? a : 0;
        if (Math.abs(a - (this.cgAspect || 0)) < 0.005) return;
        this.cgAspect = a;
        this.fit();
    }

    // ───────── 렌더 ─────────

    renderAll() {
        this.renderCg();
        this.renderBanner();
        this.renderStatus();
        this.renderDialogue();
        this.renderChoices();
        this.renderMenu();
        if (this.s.overlay) {
            // 생성 중에는 패널을 건드리지 않고, 끝난 뒤 한 번만 갱신한다
            if (this.s.generating) this.overlayDirty = true;
            else this.renderOverlay(true);
        }
    }

    /**
     * 배경 CG. 새 턴이면 그 턴의 장면 전환(암전·화이트아웃)과 회상 톤을 적용한다.
     * 암전·화이트아웃은 화면이 가려진 순간에 그림을 바꿔야 자연스러워서 교체를 조금 늦춘다.
     */
    renderCg() {
        const t = this.turn();
        const turnKey = `${this.s.view}:${t?.mesId}:${t?.swipeId}`;
        const newTurn = turnKey !== this.lastCgTurnKey;
        this.lastCgTurnKey = turnKey;
        const fxOn = this.fxOn();
        this.root.classList.toggle('pp-tone-flashback', fxOn && t?.pp?.tone === 'flashback');
        const transition = fxOn && newTurn && !this.skipTransition ? t?.pp?.transition : '';
        this.skipTransition = false;

        const url = this.cgFor(this.s.view);
        const { cgA, cgB, cgEmpty } = this.el;
        cgEmpty.hidden = !!url;
        const front = cgA.classList.contains('pp-on') ? cgA : cgB.classList.contains('pp-on') ? cgB : null;
        const covered = transition === 'fade' || transition === 'whiteout';
        if (covered) this.playFx(transition);
        if (!url) {
            cgA.classList.remove('pp-on');
            cgB.classList.remove('pp-on');
            this.el.cgBg.style.backgroundImage = '';
            this.setCgAspect(0);
            return;
        }
        if (front && front.getAttribute('src') === url) return;
        const back = front === cgA ? cgB : cgA;
        // 장면 전환 중이면 바로 바꾸고(가려져 있으니), 아니면 디졸브
        back.classList.toggle('pp-instant', covered);
        back.onload = () => {
            const swap = () => {
                this.el.cgBg.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
                this.setCgAspect(back.naturalWidth / back.naturalHeight);
                // 세로 그림 표시 (세로 화면에서 칸 맨 위에 붙일지 정할 때 쓴다)
                back.classList.toggle('pp-tall', back.naturalHeight > back.naturalWidth);
                back.classList.add('pp-on');
                if (front) { front.classList.toggle('pp-instant', covered); front.classList.remove('pp-on'); }
            };
            if (covered) setTimeout(swap, 450); else swap();
        };
        back.onerror = () => { cgEmpty.hidden = false; };
        back.setAttribute('src', url);
    }

    renderBanner() {
        const b = this.el.banner;
        b.hidden = !this.replay;
        if (!this.replay) return;
        const t = this.turn();
        const meta = this.meta(t);
        b.replaceChildren(
            h('span', { class: 'pp-banner-tag', text: '회상' }),
            h('span', { text: `TURN ${this.s.view + 1}${meta ? ' · ' + meta : ''}` }),
            h('button', { class: 'pp-banner-btn', text: '현재로 돌아가기', onclick: () => this.backToNow() }),
            // 회상하던 턴에서 바로 분기 (LOG에서 다시 찾지 않아도 되게)
            this.o.onBranch && t ? h('button', {
                class: 'pp-banner-btn', text: '여기서 분기', title: '이 턴까지를 복사해 새 채팅(분기)으로 이어가기',
                onclick: async () => {
                    if (await this.confirmBranch(this.s.view)) this.o.onBranch(t);
                },
            }) : null);
    }

    /** 분기 확인 (회상 띠 · LOG 공통). 확인 창은 어댑터(실리태번 팝업)에 맡기고, 없으면 브라우저 기본 창 */
    async confirmBranch(i) {
        const msg = `TURN ${i + 1}에서 분기를 만들까요?\n이 턴까지 복사한 새 채팅으로 이동해요. 지금 채팅은 그대로 남아요.`;
        return this.o.confirm ? !!(await this.o.confirm(msg, '분기 만들기')) : window.confirm(msg);
    }

    /** 왼쪽 위 정보 알약(글자형 항목 한 줄). 누르면 아래로 전체 상태가 펼쳐진다 */
    renderStatus() {
        const t = this.turn();
        // 접힌 표시는 상태창 설정 순서대로 글자형 항목 앞의 2개만 (항목이 많아도 알약 길이가 일정하게). 나머지는 펼치면 보인다
        const values = this.items.filter(it => it.type !== 'gauge' && it.type !== 'mind')
            .map(it => t?.state?.text[itemKey(it)]).filter(Boolean).slice(0, 2);
        const parts = [h('span', { class: 'pp-info-first', text: values[0] || 'STATUS' })];
        if (values.length > 1) parts.push(h('span', { class: 'pp-info-sub', text: values.slice(1).join(' · ') }));
        this.el.infoValues.replaceChildren(...parts);
        // 상태창 항목이 없는 채팅은 표시 자체를 숨긴다
        this.el.info.hidden = !this.turns.length || !this.items.length;
        if (this.el.info.hidden && this.s.statusOpen) this.s.statusOpen = false;
        this.el.info.classList.toggle('pp-open', !!this.s.statusOpen);
        this.el.info.setAttribute('aria-expanded', String(!!this.s.statusOpen));
        this.el.statusDrop.hidden = !this.s.statusOpen;
        this.placeSoundBtn();
        if (!this.s.statusOpen) { this.el.statusDrop.replaceChildren(); return; }
        const rows = this.statusRows();
        // 모서리를 끌어 크기 조절 (테마마다 따로 기억). 세로 창은 너비가 화면에 맞춰져 있어서 높이만
        const wide = !this.root.classList.contains('pp-portrait');
        const corner = h('button', { class: 'pp-st-corner', title: '끌어서 크기 조절', 'aria-label': '상태창 크기 조절' });
        corner.addEventListener('pointerdown', (e) => this.startStatusResize(e, wide));
        const drop = this.el.statusDrop;
        const size = this.o.statusSize?.(this.style) || {};
        const savedH = Number(size.h) || 0;
        const savedW = wide ? Number(size.w) || 0 : 0;
        drop.style.height = savedH ? `${savedH}px` : '';
        drop.style.maxHeight = savedH ? 'none' : '';
        drop.style.width = savedW ? `${savedW}px` : '';
        drop.style.maxWidth = savedW ? 'none' : '';
        // 내용은 안쪽 칸에서만 스크롤하고, 손잡이는 그 아래 따로 둔다 (글자 위에 겹치지 않게)
        const prevScroll = drop.querySelector('.pp-st-scroll')?.scrollTop || 0;
        const body = h('div', { class: 'pp-st-scroll' },
            ...(rows.length ? rows : [h('span', { class: 'pp-hint', text: '이 채팅은 상태창을 쓰지 않아요' })]),
            h('span', { class: 'pp-status-hint', text: this.replay ? '회상 중에는 수정할 수 없어요' : '' }));
        drop.replaceChildren(body, rows.length ? corner : null);
        body.scrollTop = prevScroll;
        // 처음 펼칠 때(또는 창이 작아졌을 때) 대사창을 덮지 않게, 대사창 위까지만
        const room = this.statusRoom();
        if (room) {
            if (savedH) drop.style.height = `${Math.min(savedH, room)}px`;
            else drop.style.maxHeight = `${room}px`;
        }
    }

    /** 펼친 상태창이 대사창 위까지 쓸 수 있는 높이 (무대 px). 대사창이 상태창 아래에 없으면 0 */
    statusRoom() {
        const drop = this.el.statusDrop, dlg = this.el.dialogue;
        if (drop.hidden || !dlg.offsetHeight) return 0;
        // 화면 px → 상태창 px. 무대 확대·축소에 세로 창의 상태창 확대(zoom)까지 들어 있어서 상태창 자체로 잰다
        const scale = drop.getBoundingClientRect().height / (drop.offsetHeight || 1) || 1;
        const top = drop.getBoundingClientRect().top, dlgTop = dlg.getBoundingClientRect().top;
        if (dlgTop <= top + 120 * scale) return 0;
        return Math.floor((dlgTop - top) / scale - 12);
    }

    /** 상태창 손잡이 끌기: 대사창 위까지만 늘어나고, 놓으면 그 크기를 기억한다. both면 너비도 */
    startStatusResize(e, both = false) {
        e.preventDefault();
        e.stopPropagation();
        const drop = this.el.statusDrop;
        // 화면 px → 상태창 px. 무대 확대·축소에 세로 창의 상태창 확대(zoom)까지 들어 있어서 상태창 자체로 잰다
        const scale = drop.getBoundingClientRect().height / (drop.offsetHeight || 1) || 1;
        const startY = e.clientY;
        const startX = e.clientX;
        const startH = drop.offsetHeight;
        const startW = drop.offsetWidth;
        const stageR = this.el.stage.getBoundingClientRect();
        const dropR = drop.getBoundingClientRect();
        // 오른쪽에 붙은 상태창(서브컬처)은 왼쪽으로 넓힌다
        const fromRight = dropR.right >= stageR.right - 4;
        const pad = parseFloat(getComputedStyle(drop).paddingLeft) + parseFloat(getComputedStyle(drop).paddingRight) || 0;
        const minW = Math.max(240, pad + 200);
        const maxW = Math.max(minW + 20, (fromRight ? dropR.right - stageR.left : stageR.right - dropR.left) / scale - 24);
        const dropTop = drop.getBoundingClientRect().top;
        const dlgTop = this.el.dialogue.getBoundingClientRect().top;
        const maxH = Math.max(140, (dlgTop > dropTop ? dlgTop - dropTop : window.innerHeight - dropTop) / scale - 12);
        drop.classList.add('pp-resizing');
        const move = (ev) => {
            const next = Math.max(120, Math.min(maxH, startH + (ev.clientY - startY) / scale));
            drop.style.height = `${next}px`;
            drop.style.maxHeight = 'none';
            if (!both) return;
            drop.style.width = `${Math.max(minW, Math.min(maxW, startW + (fromRight ? startX - ev.clientX : ev.clientX - startX) / scale))}px`;
            drop.style.maxWidth = 'none';
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            drop.classList.remove('pp-resizing');
            const old = this.o.statusSize?.(this.style) || {};
            this.o.onStatusSize?.(this.style, { h: Math.round(drop.offsetHeight), w: both ? Math.round(drop.offsetWidth) : Number(old.w) || 0 });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    toggleStatus(open = !this.s.statusOpen) {
        this.s.statusOpen = open;
        if (!open) this.s.editing = null;
        this.renderStatus();
        // 세로 화면은 선택지가 상태창 자리와 겹쳐서, 상태창을 펼친 동안 선택지를 숨긴다
        this.renderChoices();
    }

    /** 펼친 상태 목록 (값을 눌러 수정) */
    statusRows() {
        const t = this.turn();
        const state = t?.state;
        const ro = this.replay;
        const ed = this.s.editing;
        const rows = [];
        // 설정한 글자형 항목은 전부 보인다
        const textItems = this.items.filter(it => it.type !== 'gauge' && it.type !== 'mind');
        // 혼자 쓰는 게이지(체력 등)는 글자 항목 바로 밑에, 그다음 구분선 뒤에 호감도·속마음
        const gaugeItems = this.items.filter(it => it.type === 'gauge').sort((a, b) => Number(!!a.perChar) - Number(!!b.perChar));
        // 속마음: 호감도가 켜져 있으면 그 인물 칸의 셋째 줄, 아니면 따로 한 묶음 (이번 장면에 나온 사람만)
        const mindItem = this.items.find(it => it.type === 'mind');
        const mk = mindItem ? itemKey(mindItem) : '';
        const minds = mindItem ? state?.mind?.[mk] || {} : {};
        // 속마음은 호감도를 안 쌓는 사람까지 (명단 이름으로 모은 이번 장면 등장인물)
        const presentNow = new Set(t?.presentMind || t?.present || []);
        const mindLine = (name, row2 = false) => {
            if (!mindItem || !presentNow.has(name)) return null;
            const v = minds[name] || '';
            const isEd = !ro && ed?.kind === 'mind' && ed.key === mk && ed.name === name;
            if (isEd) return h('span', { class: 'pp-mind' + (row2 ? ' pp-mind-solo' : '') }, this.editInput('mind', mk, name, v, `${name} ${mindItem.label}`));
            // 카오모지는 메인 색으로. 괄호 안에 빈칸이 있어도("( -_-)", "ᕕ( ᐛ )ᕗ") 괄호째 묶고, 바로 붙은 글자는 본문으로
            const m = v.match(KAOMOJI_RE);
            const sp = v.indexOf(' ');
            const face = m ? m[1] : sp > 0 ? v.slice(0, sp) : '';
            const rest = m ? m[2] || '—' : sp > 0 ? v.slice(sp + 1) : v || '—';
            const body = [face ? h('b', { text: face }) : null, rest];
            return ro
                ? h('span', { class: 'pp-mind' + (row2 ? ' pp-mind-solo' : '') }, ...body)
                : h('button', { class: 'pp-mind pp-editable' + (row2 ? ' pp-mind-solo' : ''), title: '눌러서 수정', onclick: () => this.startEdit('mind', mk, name) }, ...body);
        };

        for (const it of textItems) {
            const k = itemKey(it);
            const value = state?.text[k] || '—';
            const isEd = !ro && ed?.kind === 'text' && ed.key === k;
            rows.push(h('div', { class: 'pp-st-row' },
                h('span', { class: 'pp-st-label', text: it.label }),
                isEd ? this.editInput('text', k, '', state?.text[k] || '', it.label + ' 값')
                    : ro ? h('span', { class: 'pp-st-value', text: value })
                        : h('button', { class: 'pp-st-value pp-editable', title: '눌러서 수정', text: value, onclick: () => this.startEdit('text', k, '') })));
        }

        for (const it of gaugeItems) {
            const k = itemKey(it);
            const bag = state?.gauge[k] || {};
            // 혼자 쓰는 게이지(체력 등)는 글자 항목처럼 한 줄: 이름 · 막대 · 값 (제목·구분선 없이)
            if (!it.perChar) {
                const v = bag._ ?? this.o.startValue?.() ?? 50;
                const isEd = !ro && ed?.kind === 'gauge' && ed.key === k && ed.name === '_';
                const shown = this.o.formatGauge?.(it, '_', v) ?? v;
                rows.push(h('div', { class: 'pp-st-row pp-gauge-line' },
                    h('span', { class: 'pp-st-label', text: it.label }),
                    h('span', { class: 'pp-bar' }, h('span', { class: 'pp-bar-fill', style: `width:${v}%` })),
                    isEd ? this.editInput('gauge', k, '_', String(Math.round(v)), it.label)
                        : ro ? h('span', { class: 'pp-bar-v', text: shown })
                            : h('button', { class: 'pp-bar-v pp-editable', title: '눌러서 수정', 'aria-label': it.label + ' 수정', text: shown, onclick: () => this.startEdit('gauge', k, '_') })));
                continue;
            }
            if (rows.length) rows.push(h('div', { class: 'pp-st-sep' }));
            const mode = this.s.affMode[k] || 'scene';
            const withMind = it.perChar && mindItem;
            const head = h('div', { class: 'pp-st-head' }, h('span', { class: 'pp-st-label', text: withMind ? `${it.label} · ${mindItem.label}` : it.label }));
            if (it.perChar) {
                const tab = (m, label) => h('button', {
                    class: 'pp-tab' + (mode === m ? ' pp-on' : ''), text: label,
                    onclick: () => { this.s.affMode[k] = m; this.renderStatus(); },
                });
                head.append(h('div', { class: 'pp-tabs' }, tab('scene', '등장'), tab('all', '전체')));
            }
            rows.push(head);
            const names = it.perChar ? this.gaugeNames(t, bag, mode) : ['_'];
            for (const name of names) {
                const v = bag[name] ?? this.o.startValue?.() ?? 50;
                const isEd = !ro && ed?.kind === 'gauge' && ed.key === k && ed.name === name;
                const label = name === '_' ? '' : name;
                const aria = (label ? label + ' ' : '') + it.label;
                const shown = this.o.formatGauge?.(it, name, v) ?? v;
                rows.push(h('div', { class: 'pp-bar-row' + (label ? '' : ' pp-bar-solo') },
                    label ? h('span', { class: 'pp-bar-name', text: label }) : null,
                    it.perChar && this.o.tierMeter ? this.tierMeter(v) : h('span', { class: 'pp-bar' }, h('span', { class: 'pp-bar-fill', style: `width:${v}%` })),
                    isEd ? this.editInput('gauge', k, name, String(Math.round(v)), aria)
                        : ro ? h('span', { class: 'pp-bar-v', text: shown })
                            : h('button', { class: 'pp-bar-v pp-editable', title: '눌러서 수정', 'aria-label': aria + ' 수정', text: shown, onclick: () => this.startEdit('gauge', k, name) }),
                    withMind ? mindLine(name) : null));
            }
            if (!names.length) rows.push(h('div', { class: 'pp-st-empty', text: '등장한 캐릭터가 없어요' }));
        }

        // 호감도 없이 속마음만: 이름 → 속마음 (탭 없이 이번 장면에 나온 사람만)
        if (mindItem && !gaugeItems.some(it => it.perChar)) {
            if (rows.length) rows.push(h('div', { class: 'pp-st-sep' }));
            rows.push(h('div', { class: 'pp-st-head' }, h('span', { class: 'pp-st-label', text: mindItem.label })));
            const names = [...presentNow];
            for (const name of names) {
                rows.push(h('div', { class: 'pp-bar-row pp-mind-row' }, h('span', { class: 'pp-bar-name', text: name }), mindLine(name, true)));
            }
            if (!names.length) rows.push(h('div', { class: 'pp-st-empty', text: '등장한 캐릭터가 없어요' }));
        }
        return rows;
    }

    /** 이번 턴에 바뀐 관계를 오른쪽 위에 잠깐 알린다 */
    showAffinityToast() {
        clearTimeout(this.affTimer);
        const t = this.turn();
        const prev = this.turns[this.s.view - 1]?.state;
        const box = this.el.affToast;
        box.hidden = true;
        if (!t?.state || this.replay) return;
        // 숫자 보기면 점수 변화를, 단계 보기면 단계가 바뀐 경우만 알린다 (작은 변화는 조용히 쌓임)
        const numbers = !!this.o.showNumbers?.();
        const changes = [];
        for (const it of this.items.filter(x => x.type === 'gauge' && x.perChar)) {
            const k = itemKey(it);
            for (const [name, v] of Object.entries(t.state.gauge[k] || {})) {
                const before = prev?.gauge[k]?.[name];
                if (before == null || before === v) continue;
                const from = this.o.formatGauge?.(it, name, before);
                const to = this.o.formatGauge?.(it, name, v);
                if (!numbers && from === to) continue;
                changes.push({ name, d: Math.round((v - before) * 10) / 10, from, to });
            }
        }
        if (!changes.length) return;
        changes.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
        const c = changes[0];
        const words = `${c.from} → ${c.to}`;
        const heart = h('span', { class: 'pp-aff-heart' + (c.d < 0 ? ' pp-down' : ''), 'aria-hidden': 'true' });
        heart.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor"/></svg>';
        const more = changes.length > 1 ? ` 외 ${changes.length - 1}명` : '';
        box.replaceChildren(heart,
            h('span', { class: 'pp-aff-name', text: c.name + more }),
            h('span', { class: 'pp-aff-words', text: numbers ? `${c.d > 0 ? '+' : ''}${c.d}` : words }));
        box.hidden = false;
        box.classList.remove('pp-rise-in');
        void box.offsetWidth;
        box.classList.add('pp-rise-in');
        this.affTimer = setTimeout(() => { box.hidden = true; }, 5000);
    }

    gaugeNames(turn, bag, mode) {
        // 시작 관계를 고른 채팅: 아직 안 만난 캐릭터(값이 없는 캐릭터)는 '전체'에도 안 보인다
        if (this.o.metOnly?.()) {
            if (mode === 'all') return Object.keys(bag);
            return [...new Set(turn?.present || [])];
        }
        if (mode === 'all') {
            const reg = this.o.getRegistered?.() || [];
            const list = reg.length ? reg : Object.keys(bag);
            return [...new Set(list)];
        }
        const present = turn?.present || [];
        return present.filter(n => n in bag || (this.o.getRegistered?.() || []).includes(n));
    }

    /** 단계 칸 막대: 지난 단계는 꽉, 지금 단계는 얼마나 찼는지, 다음 단계는 빈 칸 */
    tierMeter(v) {
        const m = this.o.tierMeter(v);
        const segs = [];
        for (let i = 0; i < m.n; i++) {
            const fill = i < m.i ? 1 : i === m.i ? Math.max(.08, m.frac) : 0;
            segs.push(h('span', { class: 'pp-seg' + (fill >= 1 ? ' pp-full' : fill > 0 ? ' pp-part' : ''), style: `--p:${Math.round(fill * 100)}%` }));
        }
        return h('span', { class: 'pp-tier-meter', 'aria-hidden': 'true' }, ...segs);
    }

    startEdit(kind, key, name) {
        this.s.editing = { kind, key, name };
        this.renderStatus();
    }

    editInput(kind, key, name, value, aria) {
        let done = false;
        const input = h('input', {
            class: kind === 'gauge' ? 'pp-edit pp-edit-num' : 'pp-edit',
            type: kind === 'gauge' ? 'number' : 'text', min: kind === 'gauge' ? '0' : null, max: kind === 'gauge' ? '100' : null,
            value, 'aria-label': aria,
        });
        const commit = (save) => {
            if (done) return;
            done = true;
            this.s.editing = null;
            const v = input.value.trim();
            if (save && v !== '' && v !== value) {
                if (kind === 'gauge' && isNaN(parseInt(v, 10))) { this.renderStatus(); return; }
                this.o.onEdit?.({ kind, key, name, value: kind === 'gauge' ? parseInt(v, 10) : v });
            } else {
                this.renderStatus();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
        setTimeout(() => { input.focus(); input.select(); }, 0);
        return input;
    }

    renderDialogue() {
        const s = this.s;
        const trans = !s.generating && this.waitingTrans;
        const waiting = (s.generating && !this.replay) || trans;
        const empty = !this.turns.length;
        this.el.dialogue.classList.toggle('pp-waiting', waiting);
        this.el.mOrig.hidden = !trans;
        // 답장을 쓰는 동안에만 "생성 중단"
        this.el.mStop.hidden = !(s.generating && this.o.onStop);
        this.placeWaitBtn();
        if (waiting || empty) {
            this.el.speakerRow.hidden = true;
            this.el.text.className = 'pp-text pp-narr';
            this.el.text.textContent = trans ? '번역 중' : waiting ? '' : '대화를 시작해 보세요.';
            this.placeWaitBtn();
            this.el.progFill.style.width = '0%';
            this.el.progCount.textContent = '';
            this.el.mBack.disabled = true;
            this.el.mFwd.disabled = true;
            this.el.next.hidden = true;
            return;
        }
        const ln = this.line();
        // 그림 여러 장인 답장: 문장을 넘길 때(앞뒤 모두) 그 자리의 그림으로
        if (this.turn()?.cgSeq) this.renderCg();
        this.el.speakerRow.hidden = !ln.n;
        this.el.speaker.textContent = ln.n;
        this.el.text.className = 'pp-text' + (ln.n ? '' : ' pp-narr');
        this.renderText();
        this.renderProgress();
        this.renderTools();
        this.maybeFx();
        this.maybeLineFx();
        // 그 턴의 BGM (같은 곡이면 이어서 튼다. 회상 중엔 그 턴 당시의 곡)
        this.o.onBgm?.(this.turn()?.bgm || '');
        // 마지막 턴에서 읽은 문장을 기억해 둔다 (나갔다 와도 거기서부터)
        if (!this.replay && this.s.view === this.CUR) this.o.onPosition?.(this.turn(), this.s.page);
    }

    /**
     * 타이핑 중에도 문장 전체를 깔아 두고 아직 안 나온 부분만 숨긴다.
     * 그래야 줄 끝에서 치던 단어가 다음 줄로 튀지 않는다. 방금 나온 글자는 짧게 페이드
     */
    renderText() {
        // 채팅창에서만 보이는 화면(상태창 HTML·버튼 등) 자리: 누르면 TEXT 창의 그 부분으로
        if (this.line().extra) {
            this.s.chars = this.line().t.length;
            this.el.text.classList.add('pp-done');
            this.el.text.replaceChildren(h('button', {
                class: 'pp-extra-link', text: '▤ 정규식 읽기', title: '정규식으로 그려진 화면(상태창·게시판·버튼 등)만 크게 보기',
                // 몇 번째 "정규식 읽기" 줄인지 같이 넘겨 그 자리 화면만 연다
                onclick: (e) => { e.stopPropagation(); this.openExtra(Math.max(0, this.s.view), this.lines().slice(0, this.s.page).filter(l => l.extra).length); },
            }));
            return;
        }
        const t = this.line().t;
        const n = Math.min(this.s.chars, t.length);
        // 문장을 다 보여 줬는지 (테마가 끝 표시를 붙일 때 쓴다)
        this.el.text.classList.toggle('pp-done', n >= t.length && t.length > 0);
        if (n >= t.length) { this.el.text.textContent = t; return; }
        const k = Math.max(0, n - 1);
        this.el.text.replaceChildren(t.slice(0, k),
            h('span', { class: 'pp-ch-new', text: t.slice(k, n) }),
            h('span', { class: 'pp-ch-rest', text: t.slice(n) }));
    }

    /** 그 문장으로 올 때마다(앞으로든 뒤로든) 문장에 붙은 효과([fx:…])·효과음([sfx:…])을 재생한다 */
    maybeLineFx() {
        const t = this.turn();
        const key = `${this.s.view}:${t?.mesId}:${t?.swipeId}:${this.s.page}`;
        if (key === this.lastLineFxKey) return;
        this.lastLineFxKey = key;
        for (const fx of this.line().fx || []) this.playFx(fx);
        for (const s of this.line().sfx || []) this.o.playSfx?.(s);
    }

    renderProgress() {
        const L = this.lines();
        const p = this.s.page;
        const total = Math.max(1, L.length);
        this.el.progFill.style.width = `${Math.round(((p + 1) / total) * 100)}%`;
        this.el.progCount.textContent = L.length ? `${p + 1} / ${L.length}` : '';
        this.el.next.hidden = !(this.typed() && !this.atEnd());
        // 회상 중에는 첫 문장에서도 이전 턴으로, 마지막 문장에서도 다음 턴으로 넘어갈 수 있다
        this.el.mBack.disabled = !L.length || (p <= 0 && this.s.view <= 0);
        this.el.mFwd.disabled = !L.length || (this.atEnd() && this.typed() && !this.replay);
    }

    /** 세로 창: 선택지를 대사창 바로 위에 붙인다 (대사가 길어 창이 높아져도 겹치지 않게). 가로 창은 CSS 위치 그대로 */
    placeChoices() {
        const box = this.el.choices;
        if (!this.root.classList.contains('pp-portrait') || box.hidden) { box.style.bottom = ''; return; }
        const stageH = this.el.stage.offsetHeight;
        // 이름표가 대사창 위로 튀어나온 테마(미연시)는 이름표 위까지 띄운다
        const sp = this.el.speakerRow;
        const lift = !sp.hidden && sp.offsetParent === this.el.dialogue ? Math.min(0, sp.offsetTop) : 0;
        box.style.bottom = `${stageH - this.el.dialogue.offsetTop - lift + 16}px`;
    }

    choicesVisible() {
        return !this.el.choices.hidden;
    }

    renderChoices() {
        const show = this.turns.length === 0
            ? !this.s.generating
            : this.typed() && this.atEnd() && !this.replay && !this.s.generating && !this.waitingTrans
                && !(this.s.statusOpen && this.root.classList.contains('pp-portrait'));
        const box = this.el.choices;
        const wasHidden = box.hidden;
        box.hidden = !show;
        if (!show) return;
        // 선택지를 끈 설정이면 버튼 없이 입력칸만
        const choices = this.o.choicesOn?.() === false ? [] : this.turn()?.pp?.choices || [];
        // 채팅창이 바뀔 때마다(그림 생성 진행 표시 등) 다시 그려지는데, 같은 선택지면 버튼을 그대로 둔다.
        // 누르는 사이에 버튼이 새로 바뀌면 클릭이 사라진다
        const key = choices.join('\u0001');
        if (!wasHidden && key === this.choiceKey && this.el.choiceList.childElementCount === choices.length) { this.placeChoices(); return; }
        this.choiceKey = key;
        this.el.choiceList.replaceChildren(...choices.map((c, i) => h('button', {
            class: 'pp-choice', title: `${i + 1}번 키로도 고를 수 있어요`, onclick: () => this.pickChoice(c),
        }, h('span', { class: 'pp-choice-num', text: String(i + 1) }), h('span', { class: 'pp-choice-text', text: c }))));
        this.placeChoices();
        if (wasHidden) {
            box.classList.remove('pp-rise');
            void box.offsetWidth;
            box.classList.add('pp-rise');
        }
    }

    /**
     * 바깥 메뉴는 늘 버튼 3개 + ⋯ (테마마다 메뉴 칸 크기가 정해져 있어서 개수를 고정한다).
     * 고른 3개는 고른 순서가 아니라 아래 MENU_KEYS 순서로, 나머지는 ⋯ 안으로
     */
    setMenuOuter(list) {
        const el = this.el;
        const all = { skip: el.mSkip, log: el.mLog, cg: el.mCg, auto: el.mAuto, text: el.mText, hide: el.mHide, qr: el.mQr, theme: el.mTheme, chat: el.mChat };
        const keys = Object.keys(all);
        const pick = new Set((list || []).filter(k => all[k]).slice(0, MENU_OUTER_COUNT));
        // 3개가 안 되면 기본값(SKIP·LOG·CG)부터 채운다
        for (const k of [...MENU_OUTER_DEFAULT, ...keys]) { if (pick.size >= MENU_OUTER_COUNT) break; pick.add(k); }
        el.menuMain.replaceChildren(...keys.filter(k => pick.has(k)).map(k => all[k]), el.mMore);
        el.morePanel.replaceChildren(...keys.filter(k => !pick.has(k)).map(k => all[k]));
        // 처음 만들 때(build 중)는 화면을 다 만든 뒤 그린다
        if (this.root) this.renderMenu();
    }

    /** 상태 알약 오른쪽에 스피커 (알약이 없는 채팅이면 그 자리에) */
    renderSoundBtn() {
        const b = this.el?.soundBtn;
        if (!b) return;
        b.hidden = !this.o.soundAvailable?.();
        if (b.hidden) return;
        const on = !!this.o.soundOn?.();
        b.classList.toggle('pp-off', !on);
        b.title = on ? 'BGM·효과음 끄기' : 'BGM·효과음 켜기';
        b.setAttribute('aria-label', b.title);
        b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z" fill="currentColor"/>${on ? '<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>' : '<path d="M16 9l5 6M21 9l-5 6"/>'}</svg>`;
        this.placeSoundBtn();
    }

    /**
     * 생성 중단 · 원문으로 보기: 대사창의 대기 표시(… 깜빡임 · "번역 중") 바로 위에 붙인다.
     * 깜빡임은 글자 칸의 ::after라 잴 수 없어서, 같은 줄에 빈 표시를 하나 넣어 그 자리를 잰다
     */
    placeWaitBtn() {
        if (!this.el.mStop || !this.el.ui) return;
        const b = [this.el.mStop, this.el.mOrig].find(x => !x.hidden);
        if (!b) return;
        let mark = this.el.text.querySelector('.pp-wait-mark');
        if (!mark) { mark = h('span', { class: 'pp-wait-mark', 'aria-hidden': 'true' }); this.el.text.prepend(mark); }
        const ui = this.el.ui.getBoundingClientRect();
        const scale = ui.width / (this.el.ui.offsetWidth || 1) || 1;
        const m = mark.getBoundingClientRect();
        const t = this.el.text.getBoundingClientRect();
        const bw = b.offsetWidth * scale, bh = b.offsetHeight * scale, gap = 8 * scale;
        const center = getComputedStyle(this.el.text).textAlign === 'center';
        const x = center ? t.left + (t.width - bw) / 2 : m.left;
        let y = m.top - gap - bh;
        // 세로 화면: 모든 테마에서 도구 줄(번역·휴지통·스와이프)과 같은 높이 = 대사창 테두리 + 위 여백 + 도구 줄(38px) 가운데
        if (this.root.classList.contains('pp-portrait')) {
            const d = this.el.dialogue.getBoundingClientRect();
            const cs = getComputedStyle(this.el.dialogue);
            const top = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
            y = d.top + (top + (38 - b.offsetHeight) / 2) * scale;
            // 시네마는 버튼이 가운데라 "원문으로 보기"(긴 버튼)가 도구 줄의 번역 아이콘과 겹친다 → "번역 중" 글 아래에
            // (자리 재는 표시는 빈 칸이라 높이가 없다 → 글줄 높이만큼 내려서 그 아래 10px)
            if (center && b === this.el.mOrig) {
                const tcs = getComputedStyle(this.el.text);
                const lh = parseFloat(tcs.lineHeight) || (parseFloat(tcs.fontSize) || 16) * 1.6;
                y = m.top + (lh + 10) * scale;
            }
        }
        b.style.left = `${(x - ui.left) / scale}px`;
        b.style.top = `${(y - ui.top) / scale}px`;
    }

    placeSoundBtn() {
        const b = this.el.soundBtn, info = this.el.info;
        if (b.hidden) return;
        // 위치는 화면 좌표로 재서 무대 좌표로 바꾼다 (무대가 확대·축소돼 있고, 무대 밖 흐린 칸까지 재면 어긋난다)
        const parent = (b.offsetParent || this.el.ui).getBoundingClientRect();
        const stage = this.el.stage.getBoundingClientRect();
        const scale = stage.height / (this.el.stage.offsetHeight || 1) || 1;
        const shown = !info.hidden && info.offsetWidth > 0;
        // 알약이 숨어 있으면(상태창을 안 쓰는 채팅) 알약이 있을 자리에 둔다
        if (!shown) { info.style.visibility = 'hidden'; info.hidden = false; }
        const r = info.getBoundingClientRect();
        // 테마가 바뀌는 순간에는 알약 바탕이 전환 중이라, 전환을 끄고 최종 색을 읽는다
        const tr = info.style.transition;
        info.style.transition = 'none';
        const cs = getComputedStyle(info);
        const look = {};
        for (const k of ['backgroundColor', 'backgroundImage', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'color', 'backdropFilter']) look[k.replace('Top', '')] = cs[k];
        info.style.transition = tr;
        if (!shown) { info.hidden = true; info.style.visibility = ''; }
        const size = r.height / scale;
        b.style.height = `${size}px`;
        const bw = size * scale, gap = 8 * scale;
        let x;
        // 알약이 숨어 있으면 알약 자리에. 오른쪽 끝에 붙는 알약(서브컬처)은 그 오른쪽 끝에 맞춘다
        if (!shown) x = r.left > stage.left + stage.width / 2 ? r.right - bw : r.left;
        else x = r.right + gap + bw <= stage.right - gap ? r.right + gap : r.left - gap - bw;   // 오른쪽 끝에 붙은 알약(서브컬처)은 왼쪽에
        b.style.left = `${(x - parent.left) / scale}px`;
        b.style.top = `${(r.top - parent.top) / scale}px`;
        Object.assign(b.style, look);
    }

    renderMenu() {
        const el = this.el;
        el.mAuto.classList.toggle('pp-on', this.s.auto);
        // AUTO가 ⋯ 안에 있으니, 켜져 있으면 ⋯ 자체를 강조해서 보이게 한다
        el.mMore.classList.toggle('pp-on', !!this.s.auto || !!this.s.moreOpen);
        this.renderTools();
        el.mCg.disabled = !this.turns.length || this.s.generating;
        el.mQr.hidden = !(this.o.getQuickReplies?.() || []).length;
        el.mChat.hidden = !this.o.onChatSettings;
        this.renderSoundBtn();
        // ⋯ 안에 보일 버튼이 하나도 없으면 ⋯도 숨긴다
        el.mMore.hidden = ![...el.morePanel.children].some(b => !b.hidden);
        this.placeWaitBtn();
    }

    /** 대사창 오른쪽 위: [번역] 🗑 ‹ ↻ ›. 스와이프 묶음은 마지막 턴에서만, 번역은 문장이 한국어가 아니거나 번역된 문장일 때만 */
    renderTools() {
        const el = this.el;
        const t = this.turn(this.CUR);
        const canSwipe = !!t?.canSwipe && !this.replay && !this.s.generating;
        for (const b of [el.mPrev, el.mReroll, el.mNext, el.ansGap]) b.hidden = !canSwipe;
        // 휴지통은 스와이프가 안 되는 마지막 턴(QR의 /comment·/sys 메시지 등)에서도 보인다
        el.mUndo.hidden = this.replay || this.s.generating || !this.o.canUndo?.();
        el.mPrev.disabled = !canSwipe || !(t?.swipeId > 0);
        const pos = canSwipe && t.swipeCount > 1 ? ` (${t.swipeId + 1}/${t.swipeCount})` : '';
        el.mPrev.title = `이전 스와이프${pos}`;
        el.mNext.title = `다음 스와이프${pos}`;
        const vt = this.turn();
        // 처음부터 한국어인 문장엔 숨기고, 다른 언어를 번역한 한국어 문장엔 (원문 보기용으로) 보인다
        // "정규식 읽기" 줄은 글이 한국어 이름표라 외국어 판단을 못 한다 → 번역이 아직 없으면 번역 버튼을 보여 준다 (정규식 화면도 번역본으로 다시 그려진다)
        const foreign = this.line().extra ? !vt?.trans?.has : isForeign(this.line().t);
        el.mTl.hidden = this.s.generating || !vt || !(this.o.canTranslate?.() || vt.trans?.has) || !(foreign || vt.trans?.has);
        el.mTl.title = vt?.trans?.has && !vt.trans.original ? '원문 보기' : '번역 보기';
        el.answer.hidden = !canSwipe && el.mTl.hidden && el.mUndo.hidden;
    }

    maybeFx() {
        if (this.s.page !== 0 || this.s.chars !== 0) return;
        const t = this.turn();
        const key = `${this.s.view}:${t?.mesId}:${t?.swipeId}`;
        if (this.lastFxKey === 'skip') { this.lastFxKey = key; return; }
        if (key === this.lastFxKey) return;
        this.lastFxKey = key;
        // 예전 형식(fx: 줄)은 턴 시작에 재생한다
        for (const fx of t?.pp?.fx || []) this.playFx(fx);
        this.showAffinityToast();
    }

    /** 설정의 "화면효과" (기본 켬). 끄면 흔들림·플래시·암전·화이트아웃·회상 톤 모두 안 쓴다 */
    fxOn() {
        return this.o.screenFx ? !!this.o.screenFx() : true;
    }

    /** 효과 재생. 이름은 parse.js의 표준 이름(vpunch, hpunch, flash, fade, whiteout) */
    playFx(fx) {
        if (!this.fxOn()) return;
        const spec = {
            vpunch: [this.root, 'pp-fx-vpunch', 400],
            hpunch: [this.root, 'pp-fx-hpunch', 400],
            flash: [this.el.fx, 'pp-fx-flash', 700],
            fade: [this.el.fx, 'pp-fx-fade', 1300],
            whiteout: [this.el.fx, 'pp-fx-whiteout', 1500],
        }[fx];
        if (!spec) return;
        const [target, cls, ms] = spec;
        target.classList.remove(cls);
        void target.offsetWidth;
        target.classList.add(cls);
        clearTimeout(target[`_pp_${cls}`]);
        target[`_pp_${cls}`] = setTimeout(() => target.classList.remove(cls), ms);
    }

    // ───────── 패널 (LOG / TEXT / ALBUM) ─────────

    /** back: 이 창을 닫으면 돌아갈 창 (LOG에서 연 전문 → LOG) */
    openOverlay(name, back = null) {
        this.s.overlay = name;
        this.s.overlayBack = back;
        this.renderOverlay();
    }

    /**
     * TEXT(전문)·정규식 읽기 열기. 정규식 화면은 실리태번 채팅창에 그려진 메시지에서 복사해 오므로,
     * 채팅창에 아직 안 그려진 오래된 턴이면 어댑터가 그 메시지를 먼저 불러온 뒤 연다
     */
    async openText(i, back = null) {
        this.s.textTurn = i;
        await this.o.ensureRendered?.(this.turns[i]);
        this.openOverlay('text', back);
    }

    async openExtra(i, k = null) {
        this.s.extraTurn = i;
        this.s.extraMark = k;
        await this.o.ensureRendered?.(this.turns[i]);
        this.openOverlay('extra');
    }

    /** 닫기 버튼·Esc: 돌아갈 창이 있으면 그리로(보던 스크롤 위치 그대로), 없으면 닫는다 */
    backOrClose() {
        const back = this.s.overlayBack;
        if (back && back !== this.s.overlay) {
            const top = this.s.backScroll;
            this.openOverlay(back);
            const sc = this.el.overlay.querySelector('.pp-scroll');
            if (sc && top != null) sc.scrollTop = top;
            return;
        }
        this.closeOverlay();
    }

    closeOverlay() {
        this.s.overlay = null;
        this.lastOverlayKey = '';
        this.el.overlay.hidden = true;
        this.el.overlay.replaceChildren();
    }

    panel(tag, title, body, foot, cls = '') {
        return h('div', { class: 'pp-frame pp-solid pp-panel pp-pop ' + cls, role: 'dialog', 'aria-label': title },
            h('div', { class: 'pp-panel-head' },
                h('div', { class: 'pp-panel-title' }, h('span', { class: 'pp-panel-tag', text: tag }), h('span', { class: 'pp-panel-name', text: title })),
                h('button', { class: 'pp-btn', text: '닫기', onclick: () => this.backOrClose() })),
            body, foot);
    }

    /** 패널에 보이는 내용의 지문. 같으면 다시 그리지 않는다 */
    overlayKey() {
        const s = this.s;
        const turns = this.turns.map(t => `${t.mesId}:${t.swipeId}:${(t.cgs || []).join(',')}:${(t.cgVersions || []).map(x => x.length).join('.')}:${t.cgIndex}:${[...(t.favs || [])].join(',')}:${t.lines.length}:${t.lines[0]?.t}:${t.hidden ? 1 : 0}:${t.swipeCount}`).join('|');
        const v = s.viewer ? `${s.viewer.src}:${s.viewer.pos}:${s.viewer.k}:${s.viewer.ver ?? ''}:${s.viewer.select ? [...s.viewer.select].join(',') + '#' : ''}` : '';
        return `${s.overlay}:${s.logView}:${s.textTurn}:${s.extraTurn}:${s.extraMark}:${v}:${JSON.stringify(s.logSwipe || {})}:${this.CUR}:${turns}`;
    }

    /**
     * @param {boolean} refresh 데이터가 바뀌어 다시 그리는 경우.
     *   내용이 같으면 건너뛰고, 다르면 등장 애니메이션 없이 스크롤 위치를 지켜서 바꾼다.
     */
    renderOverlay(refresh = false) {
        const ov = this.el.overlay;
        const name = this.s.overlay;
        const key = this.overlayKey();
        if (refresh && key === this.lastOverlayKey && !ov.hidden) return;
        const prevScroll = ov.querySelector('.pp-scroll')?.scrollTop;
        let node;
        if (name === 'log') node = this.logPanel();
        else if (name === 'text') node = this.textPanel();
        else if (name === 'viewer') node = this.viewerPanel();
        else if (name === 'extra') node = this.extraPanel();
        if (!node) { this.closeOverlay(); return; }
        if (refresh) {
            node.classList.remove('pp-pop');
            // 이미 불러온 이미지는 새 요소로 바꾸지 않고 그대로 옮겨 다시 로딩되며 깜빡이지 않게 한다
            const loaded = new Map();
            const keyOf = (img) => img.dataset.thumbSrc || img.getAttribute('src');
            for (const img of ov.querySelectorAll('img')) if (img.getAttribute('src')) loaded.set(keyOf(img), img);
            for (const img of node.querySelectorAll('img')) {
                const old = loaded.get(keyOf(img));
                if (old) { this.thumbObserver?.unobserve(img); old.className = img.className.replace('pp-thumb-pending', '').trim(); img.replaceWith(old); loaded.delete(keyOf(img)); }
            }
        }
        ov.classList.toggle('pp-overlay-viewer', name === 'viewer');
        ov.replaceChildren(node);
        ov.hidden = false;
        this.lastOverlayKey = key;
        const scroller = node.querySelector('.pp-scroll');
        if (!scroller) return;
        if (refresh && prevScroll != null) scroller.scrollTop = prevScroll;
        else if (name === 'log' && this.s.logView !== 'cg' && this.s.logView !== 'fav') scroller.scrollTop = scroller.scrollHeight;
    }

    /** LOG: 목록 / CG만 / ♡(즐겨찾기한 그림) */
    logPanel() {
        const view = ['cg', 'fav'].includes(this.s.logView) ? this.s.logView : 'list';
        const tab = (key, label) => h('button', {
            class: 'pp-seg-btn' + (view === key ? ' pp-on' : ''), 'aria-pressed': String(view === key), text: label,
            onclick: () => { this.s.logView = key; this.renderOverlay(); },
        });
        const toggle = h('div', { class: 'pp-seg pp-log-toggle' }, tab('list', '목록'), tab('cg', 'CG만'), tab('fav', '♡'));
        const panel = view === 'cg' ? this.cgGridPanel() : view === 'fav' ? this.favGridPanel() : this.logListPanel();
        panel.querySelector('.pp-panel-title').append(toggle);
        return panel;
    }

    logListPanel() {
        const rows = this.turns.map((t, i) => {
            const cg = t.cg;
            const first = t.lines.find(l => !l.extra);
            const readBtn = h('button', {
                class: 'pp-log-read pp-log-icon', title: '전문 (진행하지 않고 이 턴의 전체 답변 읽기)', 'aria-label': '전문',
                onclick: (e) => {
                    e.stopPropagation();
                    this.s.backScroll = this.el.overlay.querySelector('.pp-scroll')?.scrollTop ?? null;
                    this.openText(i, 'log');
                },
            }, icon('doc'));
            // ⋯ 안: 분기 · 숨기기(숨김 해제) · 여기까지 삭제. 자주 안 쓰는 동작이라 이름과 함께 한 단계 안쪽에
            const item = (name, label, fn) => h('button', { class: 'pp-vw-btn', role: 'menuitem', onclick: (e) => { e.stopPropagation(); menu.hidden = true; fn(); } }, icon(name), label);
            const menu = h('div', { class: 'pp-vw-menu pp-log-menu', hidden: true, role: 'menu', onclick: (e) => e.stopPropagation() },
                this.o.onBranch ? item('branch', '분기', async () => {
                    if (!await this.confirmBranch(i)) return;
                    this.closeOverlay();
                    // 다른 답변을 보는 중이면 그 답변으로 분기
                    this.o.onBranch(t, viewed);
                }) : null,
                // 숨김 = 이 턴(내 말·답장)을 AI에게 보내지 않기. 실리태번의 메시지 숨기기와 같다
                this.o.onToggleHidden ? item(t.hidden ? 'eye' : 'eyeOff', t.hidden ? '숨김 해제' : '숨기기', () => this.o.onToggleHidden(t, !t.hidden)) : null,
                // 첫 턴(첫 인사말)은 지우면 채팅이 비어 버려서 뺀다
                this.o.onDeleteFrom && i > 0 ? item('trash', '여기까지 삭제', () => this.o.onDeleteFrom(t)) : null);
            const moreBtn = menu.childElementCount ? h('button', {
                class: 'pp-log-read pp-log-icon', title: '더보기', 'aria-label': '더보기', 'aria-haspopup': 'menu',
                onclick: (e) => {
                    e.stopPropagation();
                    const open = menu.hidden;
                    this.el.overlay.querySelectorAll('.pp-log-menu').forEach(m => { m.hidden = true; });
                    if (!open) return;
                    // 목록 아래쪽 줄은 메뉴를 위로 펼친다 (스크롤 칸 밖으로 잘리지 않게)
                    const box = this.el.overlay.querySelector('.pp-scroll')?.getBoundingClientRect();
                    const r = e.currentTarget.getBoundingClientRect();
                    menu.classList.toggle('pp-up', !!box && r.bottom > box.top + box.height * 0.55);
                    menu.hidden = false;
                },
            }, icon('more')) : null;
            // 스와이프가 여럿이면 ‹ n/N ›로 다른 답변의 첫 문장을 미리 보고, 지우거나(마지막 턴은) 바꾼다
            const logSwipe = this.s.logSwipe || (this.s.logSwipe = {});
            const viewed = Math.min(logSwipe[t.mesId] ?? t.swipeId, t.swipeCount - 1);
            const other = viewed !== t.swipeId;
            // 다른 답변을 보는 중이면 그 답변의 첫 문장과 그림으로
            const preview = other ? this.o.swipePreview?.(t, viewed) : null;
            const rowCg = other ? preview?.cg || '' : cg;
            const swBtn = (text, title, fn, disabled = false) => h('button', { class: 'pp-log-sw-btn', text, title, disabled, onclick: (e) => { e.stopPropagation(); fn(); } });
            const swipeBar = t.swipeCount > 1 && this.o.swipePreview ? h('span', { class: 'pp-log-swipes', onclick: (e) => e.stopPropagation() },
                swBtn('‹', '이전 답변', () => { logSwipe[t.mesId] = viewed - 1; this.renderOverlay(true); }, viewed <= 0),
                h('span', { class: 'pp-log-sw-count' + (other ? ' pp-other' : ''), text: `${viewed + 1}/${t.swipeCount}` }),
                swBtn('›', '다음 답변', () => { logSwipe[t.mesId] = viewed + 1; this.renderOverlay(true); }, viewed >= t.swipeCount - 1),
                this.o.onRemoveSwipe ? (() => {
                    const b = swBtn('', '이 답변(스와이프) 지우기', async () => { if (await this.o.onRemoveSwipe(t, viewed)) delete logSwipe[t.mesId]; });
                    b.classList.add('pp-log-sw-del');
                    b.setAttribute('aria-label', '이 답변 지우기');
                    b.append(icon('trash', 13));
                    return b;
                })() : null) : null;
            // 마지막 턴에서 다른 답변을 보는 중이면 줄을 눌러 그 답변으로 바꾼다 (지난 턴은 ⋯ → 분기로 그 답변의 새 채팅)
            const canPick = other && i === this.turns.length - 1 && !!this.o.onPickSwipe;
            const go = async () => {
                if (canPick && await this.o.onPickSwipe(t, viewed)) { delete logSwipe[t.mesId]; this.closeOverlay(); return; }
                this.startReplay(i);
            };
            return h('div', {
                class: 'pp-log-row' + (t.hidden ? ' pp-log-row-hidden' : ''), role: 'button', tabindex: '0',
                title: canPick ? '이 답변으로 바꾸기' : '이 턴으로 가기',
                onclick: go,
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } },
            },
                h('span', {
                    class: 'pp-thumb' + (other && rowCg ? ' pp-thumb-open' : ''),
                    title: other && rowCg ? '이 답변의 그림 크게 보기' : null,
                    onclick: other && rowCg && this.o.swipeCgs ? (e) => { e.stopPropagation(); this.openSwipeViewer(t, viewed, i); } : null,
                },
                    rowCg ? this.thumbImg(rowCg) : h('span', { class: 'pp-thumb-empty', text: 'NO CG' }),
                    i === this.CUR ? h('span', { class: 'pp-now', text: '지금' }) : null),
                h('span', { class: 'pp-log-body' },
                    h('span', { class: 'pp-log-meta' }, h('span', { class: 'pp-log-num', text: `TURN ${i + 1}` }), h('span', { text: this.meta(t) }),
                        t.hidden ? h('span', { class: 'pp-log-hidden', title: '이 턴은 AI에게 보내지 않아요', text: '숨김' }) : null),
                    t.user ? h('span', { class: 'pp-log-user', text: '▷ ' + t.user }) : null,
                    h('span', { class: 'pp-log-prev' + (other ? ' pp-other' : ''), text: other ? preview?.text || '' : first ? (first.n ? first.n + ' — ' : '') + first.t : '' }),
                    swipeBar),
                h('span', { class: 'pp-log-actions' }, readBtn, moreBtn ? h('span', { class: 'pp-log-more-wrap' }, moreBtn, menu) : null));
        });
        return this.panel('LOG', '지난 턴 기록',
            h('div', { class: 'pp-scroll pp-log' }, rows.length ? rows : h('span', { class: 'pp-hint', text: '아직 기록이 없어요' })),
            null, 'pp-panel-lg');
    }

    textPanel() {
        const i = Math.min(this.s.textTurn, this.CUR);
        const t = this.turns[i];
        if (!t) return null;
        // 채팅창에서만 보이는 화면(정규식 상태창·QR 버튼 등)은 채팅창 모양 그대로, "정규식 읽기" 줄이 있던 자리에.
        // 그런 줄이 없는 턴(화면이 글 밖에 붙은 경우)은 맨 아래에
        const wrap = (node) => (node ? h('div', { class: 'pp-text-extra mes_text' }, node) : null);
        let k = 0;
        const hasMarks = t.lines.some(x => x.extra);
        const body = h('div', { class: 'pp-scroll pp-textview' },
            t.user ? h('div', { class: 'pp-text-user', text: '▷ ' + t.user }) : null,
            t.lines.map(x => (x.extra ? wrap(this.o.extraUiNode?.(t, k++)) : h('div', { class: 'pp-text-line' },
                x.n ? h('span', { class: 'pp-text-name', text: x.n }) : null,
                h('span', { class: x.n ? 'pp-text-t' : 'pp-text-t pp-narr', text: x.t })))),
            hasMarks ? null : wrap(this.o.extraUiNode?.(t)));
        const nav = (label, enabled, fn) => h('button', { class: 'pp-nav', text: label, disabled: !enabled, onclick: fn });
        const foot = h('div', { class: 'pp-panel-foot' },
            h('div', { class: 'pp-nav-group' },
                nav('◀ 이전 턴', i > 0, () => this.openText(i - 1, this.s.overlayBack)),
                h('span', { class: 'pp-count', text: `${i + 1} / ${this.turns.length}` }),
                nav('다음 턴 ▶', i < this.CUR, () => this.openText(i + 1, this.s.overlayBack))),
            h('button', { class: 'pp-btn-accent', text: i === this.CUR ? '이 턴 처음부터 보기' : '이 장면 다시 보기', onclick: () => this.startReplay(i) }));
        return this.panel(`TURN ${i + 1}`, this.meta(t), body, foot, 'pp-panel-lg');
    }

    /**
     * 정규식 읽기: 그 턴에서 정규식·스크립트로 그려진 화면(상태창 카드·게시판·버튼 등)만 크게.
     * 제목·턴 이동 없이 닫기만 둔다 (대사창의 "▤ 정규식 읽기"로 연다)
     */
    extraPanel() {
        const t = this.turns[Math.min(this.s.extraTurn ?? this.s.view, this.CUR)];
        if (!t) return null;
        const node = this.o.extraUiNode?.(t, this.s.extraMark ?? null) || this.o.extraUiNode?.(t);
        return h('div', { class: 'pp-frame pp-solid pp-panel pp-pop pp-panel-extra', role: 'dialog', 'aria-label': '정규식 읽기' },
            h('div', { class: 'pp-panel-head pp-extra-head' },
                h('button', { class: 'pp-btn', text: '닫기', onclick: () => this.backOrClose() })),
            h('div', { class: 'pp-scroll pp-extra-view' },
                node ? h('div', { class: 'pp-text-extra mes_text' }, node)
                    : h('span', { class: 'pp-hint', text: '정규식으로 그려진 화면을 찾지 못했어요' })));
    }

    /** 채팅의 CG(리롤 버전 포함)가 기준 이상이면 LOG·격자에 썸네일을 쓴다 */
    useThumbs() {
        let n = 0;
        for (const t of this.turns) n += t.cgs?.length || (t.cg ? 1 : 0);
        return n >= THUMB_THRESHOLD;
    }

    /** LOG·격자용 이미지. 기준 미만이면 원본, 이상이면 화면에 나타날 때 썸네일을 불러온다 */
    thumbImg(url) {
        if (!this.useThumbs()) return h('img', { src: url, alt: '', loading: 'lazy' });
        const cached = cachedThumb(url);
        if (cached) return h('img', { src: cached, alt: '', 'data-thumb-src': url });
        const img = h('img', { alt: '', 'data-thumb-src': url, class: 'pp-thumb-pending' });
        if (!this.thumbObserver) {
            this.thumbObserver = new IntersectionObserver((entries) => {
                for (const en of entries) {
                    if (!en.isIntersecting) continue;
                    const el = en.target;
                    this.thumbObserver.unobserve(el);
                    getThumb(el.dataset.thumbSrc).then((src) => {
                        el.src = src;
                        el.classList.remove('pp-thumb-pending');
                    });
                }
            }, { rootMargin: '200px' });
        }
        this.thumbObserver.observe(img);
        return img;
    }

    thumbCard({ t, i, k, label, onOpen }) {
        const url = t.cgs[k];
        const count = t.cgs.length;
        return h('div', { class: 'pp-album-item' },
            h('button', { class: 'pp-album-thumb', 'aria-label': `${label} 크게 보기`, onclick: onOpen },
                this.thumbImg(url),
                count > 1 && !t.cgSeq ? h('span', { class: 'pp-album-count', text: `${count}장` }) : null),
            h('div', { class: 'pp-album-meta' },
                h('span', { text: label }),
                this.favButton(t, url)));
    }

    cgGridPanel() {
        const items = this.cgEntries();
        const grid = h('div', { class: 'pp-scroll pp-album' }, items.map((e, pos) => this.thumbCard({
            t: this.turns[e.i], i: e.i, k: e.k,
            label: `TURN ${e.i + 1}${this.turns[e.i].cgSeq ? ` · ${e.k + 1}/${this.turns[e.i].cgs.length}` : ''}${this.meta(this.turns[e.i]) ? ' · ' + this.meta(this.turns[e.i]) : ''}`,
            onOpen: () => this.openViewer('cg', pos),
        })));
        return this.panel('LOG', '지난 턴 기록', items.length ? grid : h('div', { class: 'pp-scroll' }, h('span', { class: 'pp-hint', text: '아직 CG가 없어요' })),
            null, 'pp-panel-lg');
    }

    favGridPanel() {
        const items = this.favEntries();
        const grid = h('div', { class: 'pp-scroll pp-album' }, items.map((e, pos) => this.thumbCard({
            t: this.turns[e.i], i: e.i, k: e.k, label: `TURN ${e.i + 1}`,
            onOpen: () => this.openViewer('fav', pos),
        })));
        return this.panel('LOG', '지난 턴 기록', items.length ? grid : h('div', { class: 'pp-scroll' }, h('span', { class: 'pp-hint', text: '아직 즐겨찾기한 그림이 없어요. CG에서 하트를 눌러 모아 보세요' })),
            null, 'pp-panel-lg');
    }

    /** CG만 목록: 보통은 턴마다 대표 한 장. 한 답장에 그림이 여러 장(cgSeq)이면 장면마다 한 장씩 */
    cgEntries() {
        const out = [];
        this.turns.forEach((t, i) => {
            if (t.cgSeq) t.cgs.forEach((_, k) => out.push({ i, k }));
            else if (t.cg) out.push({ i, k: t.cgIndex });
        });
        return out;
    }

    favEntries() {
        const out = [];
        this.turns.forEach((t, i) => (t.cgs || []).forEach((url, k) => { if (t.favs?.has(url)) out.push({ i, k }); }));
        return out;
    }

    favButton(t, url) {
        const on = !!t.favs?.has(url);
        const btn = h('button', { class: 'pp-fav' + (on ? ' pp-on' : ''), 'aria-label': '즐겨찾기', 'aria-pressed': String(on), title: '즐겨찾기' });
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor" fill-opacity="var(--pp-fav-fill,0)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!t.favs) t.favs = new Set();
            const next = !t.favs.has(url);
            if (next) t.favs.add(url); else t.favs.delete(url);
            this.o.onFav?.(t, url, next);
            this.renderOverlay(true);
        });
        return btn;
    }

    // ───────── CG 뷰어 ─────────

    openViewer(src, pos) {
        const list = src === 'fav' ? this.favEntries() : this.cgEntries();
        const e = list[pos];
        if (!e) return;
        this.s.viewer = { src, pos, k: e.k };
        this.s.overlay = 'viewer';
        this.renderOverlay();
    }

    /**
     * LOG에서 미리 보던 다른 스와이프(답변)의 그림을 CG 보기로 연다. 그 답변의 리롤 버전·장면도 같은 방식으로 보이고,
     * 지난 답변이라 바꿀 수는 없어서 보기 · 저장만 된다
     */
    openSwipeViewer(t, idx, turnIndex) {
        const data = this.o.swipeCgs?.(t, idx);
        if (!data?.cgs?.length) { this.flash('이 답변에는 그림이 없어요'); return; }
        const temp = { ...t, ...data, favs: new Set(), readOnly: true, swipeOf: idx };
        const list = temp.cgSeq ? temp.cgs.map((_, k) => ({ i: turnIndex, k, t: temp })) : [{ i: turnIndex, k: temp.cgIndex, t: temp }];
        this.s.viewer = { src: 'swipe', pos: 0, k: list[0].k, list };
        this.s.overlay = 'viewer';
        this.renderOverlay();
    }

    viewerList() {
        const v = this.s.viewer;
        if (v?.src === 'swipe') return v.list;
        return v?.src === 'fav' ? this.favEntries() : this.cgEntries();
    }

    viewerMove(d) {
        const v = this.s.viewer;
        const list = this.viewerList();
        if (!v || !list.length) return;
        v.pos = (v.pos + d + list.length) % list.length;
        v.k = list[v.pos].k;
        v.ver = null;
        v.select = null;
        this.renderOverlay(true);
    }

    viewerVersion(d) {
        const v = this.s.viewer;
        const e = this.viewerList()[v?.pos];
        const t = e && (e.t || this.turns[e.i]);
        if (!t) return;
        // 장면이 여러 개인 턴: ↑↓는 지금 장면의 다른 버전
        const vers = t.cgVersions?.[v.k]?.length ? t.cgVersions[v.k] : null;
        if (vers) {
            if (vers.length < 2) return;
            v.ver = ((v.ver ?? 0) + d + vers.length) % vers.length;
        } else {
            if (t.cgs.length < 2) return;
            v.k = (v.k + d + t.cgs.length) % t.cgs.length;
        }
        this.renderOverlay(true);
    }

    closeViewer() {
        // 뷰어는 LOG에서 열었으니 닫으면 LOG로 돌아간다
        this.s.viewer = null;
        this.s.overlay = 'log';
        this.renderOverlay();
    }

    viewerPanel() {
        const v = this.s.viewer;
        const list = this.viewerList();
        if (!v || !list.length) return null;
        if (v.pos >= list.length) v.pos = list.length - 1;
        const e = list[v.pos];
        const t = e.t || this.turns[e.i];
        // 다른 스와이프 보기: 바꿀 수 없는 지난 답변이라 보기 · 저장만
        const ro = !!t.readOnly;
        const k = Math.min(v.k ?? t.cgIndex, t.cgs.length - 1);
        // 장면이 여러 개인 턴(갤러리): 점은 장면이 아니라 "이 장면을 다시 그린 버전"들
        const vers = t.cgVersions?.[k]?.length ? t.cgVersions[k] : null;
        // 처음 열 때, 또는 다시 그리기로 버전이 늘었을 때는 지금 보이는(대표) 버전으로 맞춘다
        if (vers && (v.ver == null || v.ver >= vers.length || v.verLen !== vers.length)) v.ver = Math.max(0, vers.indexOf(t.cgs[k]));
        if (vers) v.verLen = vers.length;
        const url = vers ? vers[v.ver] : t.cgs[k];
        const pathIcon = (path) => {
            const s = h('span', { 'aria-hidden': 'true', class: 'pp-vw-ico' });
            s.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
            return s;
        };
        const navBtn = (cls, label, d) => h('button', { class: `pp-vw-nav ${cls}`, 'aria-label': label, onclick: (ev) => { ev.stopPropagation(); this.viewerMove(d); } },
            pathIcon(d < 0 ? '<path d="M15 6l-6 6 6 6"/>' : '<path d="M9 6l6 6-6 6"/>'));
        const isRep = vers ? url === t.cgs[k] : k === t.cgIndex;
        const canPick = (vers || t.cgSource === 'media') && !isRep;
        // 장면이 여러 개인데 버전 목록이 없으면(태그 치환 모드) 점·대표 고르기는 보이지 않는다 (장면 이동은 좌우 화살표)
        const verCount = vers ? vers.length : t.cgSeq ? 1 : t.cgs.length;
        const verPos = vers ? v.ver : k;
        const repPos = vers ? vers.indexOf(t.cgs[k]) : t.cgIndex;
        // 버전 목록: 작은 그림 줄 (수십 장이어도 옆으로 넘겨 본다). "여러 장 고르기"를 켜면 눌러서 골라 한 번에 지운다
        const verUrls = vers || (t.cgSeq ? [url] : t.cgs);
        const picking = v.select instanceof Set;
        const canDelete = !ro && ['media', 'scenes', 'slot', 'img'].includes(t.cgSource);
        // 목록 맨 앞: 여러 장 고르기 (고른 뒤 아래 "삭제"를 누르면 고른 그림이 지워진다)
        const chip = (text, title, fn, on = false) => h('button', { class: 'pp-vw-chip' + (on ? ' pp-on' : ''), text, title, onclick: (ev) => { ev.stopPropagation(); fn(); } });
        const pickChips = canDelete || ro ? h('div', { class: 'pp-vw-chips' },
            chip(picking ? '고르기 끝' : '여러 장 고르기', ro ? '눌러서 여러 장을 고른 뒤 한 번에 저장해요' : '눌러서 여러 장을 고른 뒤 아래 삭제로 한 번에 지워요',
                () => { v.select = picking ? null : new Set(); this.renderOverlay(true); }, picking),
            picking ? chip('대표 빼고 모두', '대표 그림만 남기고 모두 고르기', () => { v.select = new Set(verUrls.filter((_, j) => j !== repPos)); this.renderOverlay(true); }) : null) : null;
        const strip = verCount > 1 ? h('div', { class: 'pp-vw-strip' + (picking ? ' pp-picking' : ''), role: 'group', 'aria-label': '같은 그림의 다른 버전' },
            pickChips,
            verUrls.map((u, j) => h('button', {
                class: 'pp-vw-thumb' + (j === verPos ? ' pp-on' : '') + (j === repPos ? ' pp-rep' : '') + (picking && v.select.has(u) ? ' pp-sel' : ''),
                'aria-label': `${j + 1}번째 버전${j === repPos ? ' (대표)' : ''}`,
                onclick: (ev) => {
                    ev.stopPropagation();
                    if (picking) { if (v.select.has(u)) v.select.delete(u); else v.select.add(u); }
                    else if (vers) v.ver = j;
                    else v.k = j;
                    this.renderOverlay(true);
                },
            }, this.thumbImg(u), j === repPos ? h('span', { class: 'pp-vw-rep', text: '대표' }) : null))) : null;
        // 삭제: 고른 그림이 있으면 고른 것들, 없으면 지금 보는 그림
        const delTargets = picking && v.select.size ? [...v.select] : [url];
        const del = async () => {
            const urls = delTargets;
            if (!await this.o.onDeleteCgs?.(t, urls)) return;
            this.flash(urls.length > 1 ? `그림 ${urls.length}장을 지웠어요` : '그림을 지웠어요');
            v.select = null;
            if (urls.includes(url)) this.closeViewer();
        };
        // 저장도 삭제와 같다: 고른 그림이 있으면 고른 것들, 없으면 지금 보는 그림
        const save = h('button', {
            class: 'pp-vw-btn', title: delTargets.length > 1 ? `고른 ${delTargets.length}장 저장` : '지금 보는 그림을 파일로 저장',
            onclick: async (ev) => {
                ev.stopPropagation();
                for (const [n, u] of delTargets.entries()) {
                    // 확장자는 실제 파일 그대로 (png · webp · jpg가 섞여 있다)
                    const ext = String(u).split(/[?#]/)[0].match(/\.(png|webp|jpe?g|gif|avif)$/i)?.[1].toLowerCase() || 'png';
                    const a = h('a', { href: u, download: `pp-turn${e.i + 1}-${n + 1}.${ext}` });
                    document.body.append(a);
                    a.click();
                    a.remove();
                    // 여러 장을 한 번에 받으면 브라우저가 막는 경우가 있어 조금씩 띄운다
                    if (n < delTargets.length - 1) await new Promise(r => setTimeout(r, 250));
                }
            },
        }, pathIcon('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'), delTargets.length > 1 ? `저장 (${delTargets.length})` : '저장');
        const pickBtn = verCount > 1 && !ro ? h('button', {
            class: 'pp-vw-btn', disabled: !canPick,
            title: !vers && t.cgSource !== 'media' ? '태그 치환 모드에서는 대표를 바꿀 수 없어요' : isRep ? '이미 대표 그림이에요' : '배경과 LOG에 이 그림을 써요',
            onclick: async () => {
                if (!await this.o.onPickCg?.(t, k, vers ? url : '')) return;
                if (vers) t.cgs[k] = url;
                else { t.cgIndex = k; t.cg = t.cgs[k]; }
                this.renderOverlay(true);
                this.flash('대표 그림으로 정했어요');
            },
        }, pathIcon('<path d="M20 6L9 17l-5-5"/>'), '대표로') : null;
        const delBtn = canDelete ? h('button', {
            class: 'pp-vw-btn' + (delTargets.length > 1 ? ' pp-vw-danger' : ''),
            title: delTargets.length > 1 ? `고른 ${delTargets.length}장 지우기` : '이 그림 지우기 (원본 파일까지 지울지 물어봐요)',
            onclick: del,
        }, pathIcon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'), delTargets.length > 1 ? `삭제 (${delTargets.length})` : '삭제') : null;
        const rerollBtn = h('button', { class: 'pp-vw-btn', title: 'AutoPic으로 이 턴의 그림을 다시 생성', onclick: () => { this.o.onRerollCg?.(t, url); this.flash('그림을 다시 생성해요'); } },
            pathIcon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'), '다시 그리기');
        // 밖에는 하트 · ⋯ · 이 장면으로만. 여러 장 고르는 중에는 저장·삭제를 밖에 꺼내 둔다 (고른 장수가 보이게). 다른 스와이프 보기는 저장만
        const outside = ro ? [save] : picking ? [save, delBtn].filter(Boolean) : [];
        const menu = h('div', { class: 'pp-vw-menu', hidden: true, role: 'menu' },
            ...(picking ? [pickBtn, rerollBtn] : [pickBtn, save, delBtn, rerollBtn]).filter(Boolean));
        menu.addEventListener('click', (ev) => { if (ev.target.closest('button')) menu.hidden = true; });
        const moreBtn = h('button', {
            class: 'pp-vw-btn pp-vw-more', title: '더보기', 'aria-label': '더보기', 'aria-expanded': 'false',
            onclick: (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; moreBtn.setAttribute('aria-expanded', String(!menu.hidden)); },
        }, icon('more', 18));
        const root = h('div', {
            class: 'pp-viewer pp-pop', role: 'dialog', 'aria-label': 'CG 크게 보기',
            onclick: (ev) => { if (ev.target === root || ev.target.classList.contains('pp-vw-stage')) this.closeViewer(); },
        },
            h('div', { class: 'pp-vw-stage' }, h('img', { class: 'pp-vw-img', src: url, alt: `TURN ${e.i + 1} CG` })),
            h('button', { class: 'pp-vw-close', 'aria-label': '닫기', onclick: (ev) => { ev.stopPropagation(); this.closeViewer(); } }, pathIcon('<path d="M6 6l12 12M18 6L6 18"/>')),
            list.length > 1 ? navBtn('pp-vw-prev', '이전 그림', -1) : null,
            list.length > 1 ? navBtn('pp-vw-next', '다음 그림', 1) : null,
            h('div', { class: 'pp-vw-bar', onclick: (ev) => ev.stopPropagation() },
                h('div', { class: 'pp-vw-info' },
                    h('span', { class: 'pp-vw-turn', text: `TURN ${e.i + 1}${ro ? ` · 답변 ${t.swipeOf + 1}/${t.swipeCount}` : ''}` }),
                    h('span', { class: 'pp-vw-meta', text: this.meta(t) }),
                    t.cgSeq ? h('span', { class: 'pp-vw-ver', text: `장면 ${k + 1}/${t.cgs.length}` }) : null,
                    verCount > 1 ? h('span', { class: 'pp-vw-ver', text: `버전 ${verPos + 1} / ${verCount}${isRep ? ' · 대표' : ''}` }) : null),
                strip,
                // 여러 장 고르는 중에는 한 장에만 쓰는 하트 · 이 장면으로를 숨긴다 (저장(3) · 삭제(3)로 늘어난 줄이 폰 화면 밖으로 밀리지 않게)
                h('div', { class: 'pp-vw-actions' },
                    ro || picking ? null : this.favButton(t, url),
                    ...outside,
                    ro ? null : h('span', { class: 'pp-vw-more-wrap' }, moreBtn, menu),
                    ro || picking ? null : h('button', { class: 'pp-vw-btn pp-vw-go', onclick: () => { this.s.viewer = null; this.startReplay(e.i, { cg: t.cgs[k] }); } },
                        pathIcon('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'), '이 장면으로'))));
        return root;
    }
}

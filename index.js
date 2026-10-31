// 픽플레이 - 실리태번 어댑터
// 채팅 데이터를 턴으로 묶어 엔진에 넘기고, 엔진의 동작(전송·스와이프·수정)을 실리태번에 반영한다.

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    generateRaw,
    systemUserName,
    showMoreMessages,
    getRequestHeaders,
    deleteSwipe,
    swipe as stSwipe,
    isGenerating as stSendBusy,
} from '../../../../script.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../../constants.js';
import { isExecutingCommandsFromChatInput } from '../../../slash-commands.js';
import { getSortedEntries } from '../../../world-info.js';
import { branchChat } from '../../../bookmarks.js';
import { hideChatMessageRange } from '../../../chats.js';
import { getCurrentUserHandle } from '../../../user.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { PPEngine, MENU_OUTER_COUNT, MENU_OUTER_DEFAULT, isForeign } from './engine.js';
import { PPSound, isStopWord } from './sound.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { cleanText, splitLines, parseMessagePp, foldStates, emptyState, itemKey, GAUGE_DEFAULT, setHiddenTags, extraLine, EXTRA_MARK, stripHiddenBlocks } from './parse.js';
import { AFFINITY, tierOf, buildTraitsPrompt, traitsCardText, traitsLoreText, parseJsonLoose, parseTraits, clampMult } from './game.js';

const MODULE = 'pickplay';
const PROMPT_KEY = 'PICKPLAY';
const FOLDER = new URL('.', import.meta.url).pathname;

const defaultSettings = {
    enabled: false,
    items: [
        { id: 'time', label: '시간대', type: 'text', perChar: false },
        { id: 'place', label: '장소', type: 'text', perChar: false },
        { id: 'weather', label: '날씨', type: 'text', perChar: false },
        // 시스템 상태창: 프롬프트가 정해져 있어 이름·종류는 못 바꾸고 켜기/끄기만 한다 (enabled = 새 채팅 기본값)
        { id: 'aff', label: '호감도', type: 'gauge', perChar: true, fixed: 'aff', enabled: false },
        { id: 'mind', label: '속마음', type: 'mind', perChar: true, fixed: 'mind', enabled: false },
    ],
    affinityDisplay: 'tier',
    // 카드(그룹)마다 만든 캐릭터 기질 { 카드 키: { 이름: 기질 } }. 같은 카드의 새 채팅은 이걸 그대로 쓴다
    cardTraits: {},
    dialogueStyle: 'box',
    // 화면효과: 흔들림·플래시·암전·화이트아웃·회상 톤
    screenFx: true,
    // BGM·효과음: 기본은 끔. soundMuted는 VN 화면 상태 알약 옆 스피커 버튼
    sound: false,
    soundMuted: false,
    bgmVolume: 50,
    sfxVolume: 80,
    // 바깥 메뉴 버튼 3개 (skip·log·cg·auto·text·hide·qr·theme·chat 중). 나머지는 ⋯ 안
    menuOuter: ['skip', 'log', 'cg'],
    // AI 지시 틀 (빈 문자열이면 기본 틀)
    promptTemplate: '',
    fontSize: 21,
    windowAlpha: 1,
    accent: '#f2a7b8',
    replyLength: 'preset',
    // VN 화면에서 통째로 뺄 블록 (프롬프트의 설계 메모·경고문·생각 등)
    hiddenTags: 'details, summary, preset_validation, think, thinking, reasoning, analysis, plan, ooc',
    typingMs: 40,
    readySound: true,
    // 선택지: 끄면 AI에게 선택지를 받지 않고 버튼도 안 보인다 (입력칸은 그대로)
    choices: true,
    autoMs: 1500,
};

let engine = null;
let host = null;
let turns = [];
let registered = [];
let allLoreNames = [];
let loreMeta = new Map(); // 로어북 이름 → 인물로 보이는지
let loreKeys = new Map(); // 로어북 이름 → 키워드 (같은 사람 추측용)
let lastKey = '';
let rebuildTimer = null;
let pendingFollow = 'keep';
let pendingGenerationEnd = false;
let traitsToken = 0;
let traitsBusy = false;

const settings = () => extension_settings[MODULE];

/** 답변 분량 지시. preset이면 프리셋에 맡기고 아무것도 넣지 않는다 */
// 범위만 주면 AI가 위쪽으로 넘기기 쉬워서, 최댓값을 '넘으면 안 되는 상한'으로 따로 못 박는다
// 화면은 90자(parse.js MAX_CHUNK)를 넘는 줄을 여러 장으로 나눠 보여 준다. 그래서 줄 수만 정하면
// 긴 서술 문단 12줄이 30장 넘게 나온다 → 한 줄 = 한 화면(짧은 문장 1~2개)으로 못 박고, 긴 줄은 여러 줄로 센다
// 줄 수만으로는 안 지켜서(긴 소설 문단을 그대로 씀) 이야기 부분 전체 글자 수 상한도 같이 준다. 이 길이 지시는 프리셋의 분량 지시보다 우선
const LINE_RULE = ' One line = one screen: keep every line to one or two short sentences (about 80 characters at most). A longer paragraph counts as several lines, so split it or cut it.';
const lengthRule = (min, max, chars) => `Write ${min} to ${max} lines in total, counting every dialogue and narration line. ${max} is a hard maximum: wrap up the moment before line ${max + 1} even if the scene continues next turn.${LINE_RULE} The story part (everything before the status block) must stay under about ${chars} characters (about ${Math.round(chars / 5)} words in English). This length rule overrides any other length or detail instruction.`;
const REPLY_LENGTH = {
    short: lengthRule(8, 12, 900),
    medium: lengthRule(15, 20, 1500),
    long: lengthRule(25, 35, 2600),
};
/** 이 채팅의 캐릭터 기질. 채팅 것(pp_traits) → 이 카드에서 만든 기질 순서로 읽는다 */
function traits() {
    const md = getContext().chatMetadata || {};
    return md.pp_traits?.traits || cardTraits() || null;
}

/** 카드(그룹) 기준 키. 기질은 카드마다 한 번 만들고 같은 카드의 채팅이 함께 쓴다 */
function cardKey() {
    const ctx = getContext();
    if (ctx.groupId) return `group:${ctx.groupId}`;
    return ctx.characters?.[ctx.characterId]?.avatar || '';
}

function cardTraits() {
    const k = cardKey();
    const t = k ? settings().cardTraits?.[k] : null;
    return t && Object.keys(t).length ? t : null;
}

/** 이 채팅에서 고른 상태창 { on, ids }. 아직 안 물어봤으면 null (그동안은 전체 항목을 쓴다) */
function statusChoice() {
    return getContext().chatMetadata?.pp_status || null;
}

/** 설정의 항목 중 이 채팅에서 쓰는 것. 상태창을 끈 채팅은 빈 목록 → 지시·상태창 모두 없음 */
function activeItems() {
    const c = statusChoice();
    // 아직 고르지 않은 채팅: 확장 설정의 기본값 (시스템 상태창은 켜 둔 것만)
    if (!c) return settings().items.filter(it => !it.fixed || it.enabled);
    if (!c.on) return [];
    // 고른 채팅: 그 채팅에서 고른 것. 시스템 상태창도 확장 설정에서 꺼 두었든 상관없이 그 채팅에서 켰으면 쓴다
    // (확장 설정의 켜기/끄기는 새 채팅의 기본값). 고를 때 없던 시스템 항목은 확장 설정에서 켜 두었으면 기본으로
    const ids = new Set(activeItemIds(c));
    const list = [...settings().items.filter(it => ids.has(it.id)), ...chatItems(c)];
    // 이 채팅에서 커스텀 항목 순서를 바꿨으면 그 순서로 (상태 알약은 앞의 2개를 보여 준다). 시스템 항목은 뒤에
    if (!Array.isArray(c.order)) return list;
    const rank = (it) => { const i = c.order.indexOf(it.id); return i < 0 ? c.order.length : i; };
    return [...list.filter(it => !it.fixed).sort((a, b) => rank(a) - rank(b)), ...list.filter(it => it.fixed)];
}

/** VN 화면의 "이 채팅 상태창"(⋯ → STATUS)에서 추가한, 이 채팅에서만 쓰는 항목 */
function chatItems(c = statusChoice()) {
    return Array.isArray(c?.extra) ? c.extra.filter(it => it?.id && it.label) : [];
}

function affinityKey() {
    const it = activeItems().find(x => x.type === 'gauge' && x.perChar);
    return it ? itemKey(it) : null;
}

function loadSettings() {
    const saved = extension_settings[MODULE] || {};
    extension_settings[MODULE] = Object.assign(structuredClone(defaultSettings), saved);
    const s = settings();
    if (!Array.isArray(s.items)) s.items = structuredClone(defaultSettings.items);
    if (!Array.isArray(s.menuOuter)) s.menuOuter = [...MENU_OUTER_DEFAULT];
    // 시스템 상태창(호감도·속마음)은 항상 목록에 있어야 한다 (켜기/끄기만)
    for (const def of defaultSettings.items.filter(it => it.fixed)) {
        if (!s.items.some(it => it.fixed === def.fixed)) s.items.push(structuredClone(def));
    }
    setHiddenTags(String(s.hiddenTags || '').split(','));
    if (!Array.isArray(s.tiers) || !s.tiers.length) s.tiers = AFFINITY.tiers.map(({ label, min }) => ({ label, min }));
    applyTiers();
}

/** 설정의 호감도 단계(이름·시작 점수)를 규칙에 반영한다. 첫 단계는 항상 0부터 */
function applyTiers() {
    const list = settings().tiers
        .map(t => ({ label: String(t.label || '').trim() || '단계', min: Math.max(0, Math.min(100, Math.round(Number(t.min) || 0))) }))
        .sort((a, b) => a.min - b.min);
    list[0].min = 0;
    AFFINITY.tiers = list.map((t, i) => ({ key: 't' + i, ...t }));
}

// ───────── 채팅 → 턴 ─────────

/**
 * 메시지의 CG 버전 목록과 대표 그림 위치.
 * @returns {{list: string[], index: number, source: 'media'|'slot'|'img'|'legacy'|''}}
 *   media(현재 메시지에 삽입 모드)일 때만 대표를 바꿀 수 있다 (media_index).
 */
function findCgs(m) {
    const ex = m.extra || {};
    // AutoPic 2.0 태그 치환 모드: 본문에는 슬롯 표시만, 주소는 extra.autopic_image_slots에
    const slots = [...String(m.mes || '').matchAll(/data-autopic-slot=["']([a-zA-Z0-9-]+)["']/g)].map(x => x[1]);
    const slotPairs = slots.map(id => [id, (ex.autopic_image_slots?.[id] || m.swipe_info?.[m.swipe_id ?? 0]?.extra?.autopic_image_slots?.[id])?.src]).filter(p => p[1]);
    // ids: 슬롯 번호는 다시 그려도 그대로라 버전 기록의 열쇠로 쓴다 (슬롯 그림은 태그 기록이 안 남는 경우가 있다)
    if (slotPairs.length) return { list: slotPairs.map(p => p[1]), ids: slotPairs.map(p => p[0]), index: slotPairs.length - 1, source: 'slot' };
    // 구버전 태그 치환 모드: 본문에 <img>
    const imgs = [...String(m.mes || '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(x => x[1]);
    if (imgs.length) return { list: imgs, index: imgs.length - 1, source: 'img' };
    if (Array.isArray(ex.media) && ex.media.length) {
        const list = ex.media.filter(x => x?.url && (!x.type || x.type === 'image')).map(x => x.url);
        if (list.length) {
            const cur = ex.media[Number.isInteger(ex.media_index) ? ex.media_index : ex.media.length - 1]?.url;
            const index = Math.max(0, list.indexOf(cur) >= 0 ? list.indexOf(cur) : list.length - 1);
            return { list, index, source: 'media' };
        }
    }
    if (Array.isArray(ex.image_swipes) && ex.image_swipes.length) {
        const index = Math.max(0, ex.image ? ex.image_swipes.indexOf(ex.image) : ex.image_swipes.length - 1);
        return { list: [...ex.image_swipes], index, source: 'legacy' };
    }
    if (typeof ex.image === 'string' && ex.image) return { list: [ex.image], index: 0, source: 'legacy' };
    return { list: [], index: 0, source: '' };
}

/**
 * VN이 직접 모으는 그림 버전 기록: extra.pp_cg_history[장면 태그] = [그림 주소, …]
 * AutoPic은 다시 그릴 때 바로 직전 그림 하나만 기록에 남기므로, 그보다 오래된 버전은 여기서만 이어진다.
 * 새 주소가 보이면 메모리에 붙여 두기만 한다. 화면 그리기가 채팅 저장을 일으키지 않게, 저장은 그림을 다시 그렸을 때
 * (watchCgChange)와 실리태번이 채팅을 저장할 때 같이 된다
 */
let historyDirty = false;
function cgHistory(m, key, urls) {
    if (!key || !m?.extra) return [];
    const all = m.extra.pp_cg_history ??= {};
    const list = all[key] ??= [];
    for (const u of urls) if (u && !list.includes(u)) { list.push(u); historyDirty = true; }
    return list;
}

/**
 * 갤러리 그림을 장면별로 묶는다. AutoPic은 extra.autopic_images[주소] = 그 그림을 만든 <autopic> 태그를 남긴다.
 * 태그가 다르면 다른 장면, 같은 태그로 다시 그린 건 같은 장면의 버전(그중 가장 나중 것을 쓴다).
 * 장면이 2개 이상일 때만 장면 목록을, 아니면 null(지금처럼 버전으로 본다)
 */
function mediaScenes(m, cgs) {
    if (cgs.source !== 'media' || !cgs.list.length) return null;
    const tags = m.extra?.autopic_images;
    if (!tags || typeof tags !== 'object') return null;
    const keyOf = (url) => String(tags[url] || url).replace(/\s+/g, ' ').trim();
    const stamp = (url) => Number(String(url).match(/autopic_(\d+)_/)?.[1]) || 0;
    // 장면 순서는 갤러리에 지금 있는 순서. AutoPic 갤러리 리롤은 옛 그림을 새 그림으로 "바꿔 끼우므로",
    // 옛 버전은 extra.autopic_images 기록에만 남는다 → 같은 태그의 기록 그림을 그 장면의 버전으로 모은다
    const order = [];
    const groups = new Map();
    const current = new Map();
    for (const url of cgs.list) {
        const key = keyOf(url);
        if (!groups.has(key)) { order.push(key); groups.set(key, new Set()); }
        groups.get(key).add(url);
        current.set(key, url);
    }
    for (const url of Object.keys(tags)) {
        const key = keyOf(url);
        if (groups.has(key)) groups.get(key).add(url);
    }
    // VN이 모아 둔 더 오래된 버전도 합친다 (그리고 지금 보이는 것들을 기록에 더한다)
    for (const key of order) for (const u of cgHistory(m, key, [...groups.get(key)])) groups.get(key).add(u);
    const versions = order.map(k => [...groups.get(k)].sort((a, b) => stamp(a) - stamp(b)));
    // 장면이 하나뿐이고 버전도 하나면 지금처럼 둔다
    if (order.length < 2 && versions[0].length < 2) return null;
    // 장면마다 보여 줄 버전: 뷰어에서 "대표로" 고른 것(extra.pp_scene_pick[장면 첫 그림]) → 지금 갤러리에 있는 것 → 가장 나중 것
    const picks = m.extra?.pp_scene_pick || {};
    const keys = versions.map(v => v[0]);
    const list = versions.map((v, i) => (v.includes(picks[keys[i]]) ? picks[keys[i]] : current.get(order[i]) || v[v.length - 1]));
    return { list, versions, keys };
}

/**
 * 글 속 그림(태그 치환·<img>)의 리롤 버전. AutoPic은 다시 그리면 글 속 그림을 새 그림으로 바꾸고
 * 옛 그림은 extra.autopic_images 기록에만 남긴다 → 같은 태그의 기록 그림을 그 장면의 버전으로 모은다.
 * 버전이 하나도 없으면 null. 장면 목록(cgs.list)은 그대로 둔다 (글 속 위치 표시가 그 순서를 쓴다)
 */
function inlineVersions(m, cgs) {
    if ((cgs.source !== 'img' && cgs.source !== 'slot') || !cgs.list.length) return null;
    const tags = (typeof m.extra?.autopic_images === 'object' && m.extra.autopic_images) || {};
    // 슬롯 그림은 태그 기록이 없어도 슬롯 번호로 버전을 모을 수 있다
    if (!Object.keys(tags).length && !cgs.ids) return null;
    const keyOf = (url) => String(tags[url] || '').replace(/\s+/g, ' ').trim();
    const stamp = (url) => Number(String(url).match(/autopic_(\d+)_/)?.[1]) || 0;
    const versions = cgs.list.map((url, i) => {
        const key = keyOf(url);
        const others = key ? Object.keys(tags).filter(u => u !== url && !cgs.list.includes(u) && keyOf(u) === key) : [];
        // VN이 모아 둔 더 오래된 버전도 합친다 (그리고 지금 보이는 것들을 기록에 더한다).
        // 슬롯 그림은 슬롯 번호로 모은다: AutoPic이 옛 그림의 태그 기록을 지워서 태그로는 이어지지 않는다
        const histKey = cgs.ids?.[i] ? 'slot:' + cgs.ids[i] : key;
        const hist = histKey ? cgHistory(m, histKey, [url, ...others]).filter(u => u !== url && !cgs.list.includes(u)) : [];
        return [...new Set([url, ...others, ...hist])].sort((a, b) => stamp(a) - stamp(b));
    });
    if (versions.every(v => v.length < 2)) return null;
    const picks = m.extra?.pp_scene_pick || {};
    const keys = versions.map(v => v[0]);
    const shown = versions.map((v, i) => (v.includes(picks[keys[i]]) ? picks[keys[i]] : cgs.list[i]));
    return { versions, keys, shown };
}

/** 그림 단위 즐겨찾기 (예전 턴 단위 pp_fav도 대표 그림으로 읽는다) */
function readFavs(m, cg) {
    const favs = new Set(Array.isArray(m.extra?.pp_fav_images) ? m.extra.pp_fav_images : []);
    return favs;
}

/** 실리태번 자체 안내 메시지인지 (숨긴 일반 메시지와 구분) */
function isRealSystemMessage(m) {
    // QR·명령어로 만든 코멘트(/comment)와 내레이터(/sys)는 이야기 내용이라 VN에서도 보여준다
    if (NOTE_TYPES.has(m.extra?.type)) return false;
    return !!m.is_system && (!!m.extra?.type || m.name === systemUserName);
}

const NOTE_TYPES = new Set(['comment', 'narrator']);

// ───────── 캐릭터 명단 (호감도 · 속마음) ─────────
// 채팅마다 캐릭터를 명단으로 정하고 번호를 붙인다. AI는 이름 대신 번호로 써서
// 번역·표기 차이로 한 사람이 둘로 갈리지 않는다 (다른 표기는 aliases로 묶는다).
// pp_cast.members: [{ id, name, aliases, start: 'unmet' | 단계 번호, off }]
// off = 호감도를 쌓지 않음 (번호는 그대로 두고, 속마음은 off여도 명단 이름으로 모은다)

/** 명단을 아직 안 정한 채팅(예전 채팅)이면 null */
function castMembers() {
    const list = getContext().chatMetadata?.pp_cast?.members;
    return Array.isArray(list) ? list.filter(m => !m.removed) : null;
}

/** 명단 고르기에서 × 로 지운 이름 (다시 후보로 나오지 않게) */
function removedCastNames() {
    const list = getContext().chatMetadata?.pp_cast?.removed;
    return new Set(Array.isArray(list) ? list.map(n => normName(n)) : []);
}

/** 이 채팅이 캐릭터 명단을 쓰는지 (시스템 상태창은 모두 명단을 쓴다) */
function usesCast() {
    return activeItems().some(it => it.fixed);
}

function activeCast() {
    return (castMembers() || []).filter(m => !m.off);
}

const normName = (s) => String(s ?? '').replace(/[\s・·.]/g, '').toLowerCase();

/**
 * AI가 쓴 번호(또는 대사의 화자 이름)를 명단의 사람으로. 번호 뒤에 이름이 붙어 와도("2(柊)") 번호로 본다
 * @param {boolean} [all] 호감도를 안 쌓는 사람(off)까지 (속마음용)
 */
function memberOf(ref, all = false) {
    if (!castMembers() || ref == null) return null;
    const list = all ? castMembers() : activeCast();
    const r = String(ref).trim();
    const num = r.match(/^#?(\d+)/);
    if (num) return list.find(m => m.id === Number(num[1])) || null;
    return list.find(m => isMemberName(m, r)) || null;
}

/**
 * 명단 사람을 가리키는 이름인지: 지금 이름 · 번역 전 이름(aliases) · 예전 이름(former, 명단에서 이름을 고치기 전).
 * 예전 이름도 보는 건 고치기 전에 쌓인 기질·직접 고친 값이 그대로 이어지게
 */
function isMemberName(m, ref) {
    const n = normName(ref);
    return !!n && [m.name, ...(m.aliases || []), ...(m.former || [])].some(x => normName(x) === n);
}

/**
 * 대사 이름표에 쓸 이름: 명단 사람의 이름이나 번역 전 이름이면 명단 이름으로 (번역 안 된 이름도 같은 이름표로).
 * memberOf와 달리 번호로는 찾지 않는다 ("2B" 같은 이름이 2번 사람이 되지 않게).
 * AI·번역기는 성이나 이름만 쓰기도 해서("민수", "健太"), 띄어쓰기로 나눈 한 조각과 같아도 그 사람으로 본다.
 * 같은 조각을 가진 사람이 둘 이상이면(같은 성의 형제 등) 누군지 모르니 그대로 둔다
 */
function speakerName(n) {
    const list = castMembers();
    if (!list || !n) return n;
    const exact = list.find(x => isMemberName(x, n));
    if (exact) return exact.name;
    const k = normName(n);
    if (k.length < 2) return n;
    const pieces = (m) => [m.name, ...(m.aliases || []), ...(m.former || [])]
        .flatMap(x => String(x).split(/[\s・·.=_]+/)).map(normName).filter(p => p.length >= 2);
    const hits = list.filter(m => pieces(m).includes(k));
    return hits.length === 1 ? hits[0].name : n;
}

/** 명단 채팅이면 명단 이름(명단 밖이면 null), 예전 채팅이면 그대로 */
function castName(ref) {
    if (!castMembers()) return ref;
    return memberOf(ref)?.name ?? null;
}

/** 속마음용 이름: 명단에 있으면(호감도를 안 쌓는 사람 포함) 명단 이름, 없으면 쓴 그대로 (모르는 번호만 버림) */
function mindName(ref) {
    if (!castMembers()) return ref;
    const m = memberOf(ref, true);
    if (m) return m.name;
    return /^#?\d+/.test(String(ref).trim()) ? null : ref;
}

function initialState() {
    const key = affinityKey();
    if (!key) return null;
    const bag = {};
    for (const m of activeCast()) if (typeof m.start === 'number') bag[m.name] = tierStartValue(m.start);
    return Object.keys(bag).length ? { gauge: { [key]: bag } } : null;
}

/** 처음 판정받는 캐릭터의 시작 값: 명단 채팅은 "아직 안 만남" → 첫 단계 가운데, 예전 채팅은 50 */
function startValue() {
    return castMembers() ? tierStartValue(0) : GAUGE_DEFAULT;
}

/** 단계를 고르면 그 단계 범위의 가운데 값으로 시작한다 (지인 0~29 → 15) */
function tierStartValue(idx) {
    const t = AFFINITY.tiers;
    const min = t[idx]?.min ?? 0;
    const next = t[idx + 1]?.min;
    return next != null ? Math.round((min + next) / 2) : Math.min(100, min + 10);
}

/** 저장된 채팅 선택에 나중에 켠 추천 항목까지 더한 id 목록 (고르기 창의 체크 상태) */
function activeItemIds(c) {
    const seen = c.seen || settings().items.filter(it => it.id !== 'mind').map(it => it.id);
    return settings().items.filter(it => c.ids.includes(it.id) || (it.fixed && it.enabled && !seen.includes(it.id))).map(it => it.id);
}

/** 직접 고친 값(pp_user)의 캐릭터 이름도 명단 이름으로 (명단 밖은 버림) */
function castOverride(ov) {
    if (!(ov?.gauge || ov?.mind) || !castMembers()) return ov || null;
    // 캐릭터별 값(호감도·속마음)의 이름을 명단 이름으로 맞춘다
    const byCast = (bags, nameOf) => {
        const out = {};
        for (const [k, names] of Object.entries(bags || {})) {
            out[k] = {};
            for (const [n, v] of Object.entries(names)) {
                const c = nameOf(n);
                if (c) out[k][c] = v;
            }
        }
        return out;
    };
    return { ...ov, gauge: byCast(ov.gauge, castName), mind: byCast(ov.mind, mindName) };
}

/** 이 채팅의 판정에 나온 이름들 (명단을 처음 만들 때 예전 채팅의 이름을 옮기는 데 쓴다) */
function judgedNames() {
    const key = affinityKey();
    const names = new Set();
    for (const m of getContext().chat || []) {
        if (!m || m.is_user) continue;
        for (const src of [m.mes, m.extra?.display_text]) {
            if (typeof src !== 'string') continue;
            for (const u of parseMessagePp(src).status) if (u.name && !/^#?\d/.test(u.name) && (!key || u.key === key)) names.add(u.name);
        }
    }
    return [...names];
}

/** 로어북 키워드로 같은 사람인지 추측 (일본어 이름 ↔ 한국어 제목의 로어북 항목) */
function guessSameAs(name, cands) {
    const n = normName(name);
    for (const c of cands) {
        if (c.name === name) continue;
        const keys = (loreKeys.get(c.name) || []).map(normName).filter(k => k.length >= 2);
        if (keys.some(k => n.includes(k) || k.includes(n))) return c.name;
    }
    return '';
}

/** 답장(+번역)이 다 왔을 때 짧은 두 음 알림 (파일 없이 바로 만든다) */
let readyAudio = null;
function playReadySound() {
    try {
        readyAudio ??= new (window.AudioContext || window.webkitAudioContext)();
        const ac = readyAudio;
        const t0 = ac.currentTime + 0.01;
        for (const [freq, at] of [[880, 0], [1320, 0.11]]) {
            const o = ac.createOscillator();
            const g = ac.createGain();
            o.type = 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, t0 + at);
            g.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
            o.connect(g).connect(ac.destination);
            o.start(t0 + at);
            o.stop(t0 + at + 0.25);
        }
    } catch { /* 소리를 못 내도 동작에는 문제 없음 */ }
}

/**
 * 답장 알림: 답장(+번역)이 끝난 뒤, 그 답장의 그림까지 다 나오면 울린다.
 * 그림이 3분 넘게 안 나오면(실패 등) 기다리지 않고 울린다
 */
const READY_IMAGE_WAIT_MS = 180000;
let readyWaitSince = 0;

/** 마지막 답장의 그림을 기다려야 하는지: 그림 자리가 있는데 아직 한 장도 안 나왔으면. 여러 장이면 첫 장만 나와도 알린다 */
function imagesPending() {
    const ap = extension_settings.AutoPic;
    if (!ap || ap.insertType === 'disabled') return false;
    const m = lastAiMessage();
    if (!m) return false;
    const mes = String(m.mes || '');
    const waiting = emptySlots(m).length > 0 || /<autopic\b|<pic\s[^>]*prompt=/i.test(mes);
    if (!waiting) return false;
    // 그림 자리는 이 글에 있는 것만 본다 (다른 스와이프의 그림 자리 기록이 남아 있을 수 있다)
    const slots = m.extra?.autopic_image_slots || {};
    const done = [...mes.matchAll(/data-autopic-slot=["']([a-zA-Z0-9-]+)["']/g)].some(x => slots[x[1]]?.src) || /<img\b/i.test(mes)
        || (Array.isArray(m.extra?.media) && m.extra.media.length > 0);
    return !done;
}

function onAnswerReady() {
    if (!settings().readySound) return;
    readyWaitSince = Date.now();
    checkReadySound();
    // 그림이 끝내 안 나와 화면 갱신이 없을 때도 기다린 뒤 울리게
    setTimeout(checkReadySound, READY_IMAGE_WAIT_MS + 500);
}

function checkReadySound() {
    if (!readyWaitSince) return;
    if (imagesPending() && Date.now() - readyWaitSince < READY_IMAGE_WAIT_MS) return;
    readyWaitSince = 0;
    playReadySound();
}

/**
 * 명단 고르기 후보: 지금 명단, 로어북 인물, 이 채팅에서 판정에 나온 이름.
 * (AutoPic 등록 캐릭터는 그림용 목록이라 쓰지 않는다. 예전 채팅의 모브가 새 채팅마다 후보로 나왔다)
 * 한 사람 = 한 줄 { name, orig, former, on, start, aliases }. orig = 저장된 명단 이름(이름을 고치면 name만 바뀐다),
 * aliases = 번역 전 이름 (사용자가 직접 적는다), former = 예전 이름 (화면에는 안 보임)
 */
function castCandidates() {
    const cast = castMembers();
    const firstTime = !cast;
    const out = [];
    const find = (n) => out.find(c => [c.name, ...c.aliases, ...c.former].some(x => normName(x) === normName(n)));
    const removed = removedCastNames();
    const add = (name, extra = {}) => {
        if (!name || find(name) || removed.has(normName(name))) return;
        out.push({ name, on: false, start: 'unmet', aliases: [], former: [], ...extra });
    };
    for (const m of cast || []) add(m.name, { orig: m.name, on: !m.off, start: m.start, aliases: [...(m.aliases || [])], former: [...(m.former || [])] });
    for (const n of traitNames()) add(n, { on: firstTime });
    const judged = judgedNames();
    for (const n of judged) add(n);
    // 로어북에서 인물로 보이는 항목도 후보로 (새 채팅에서 명단이 비어 보이던 문제)
    for (const n of allLoreNames) if (loreMeta.get(n)) add(n);
    // 주인공({{user}}) 본인은 공략 대상이 아니다. 페르소나 이름과, 같은 사람으로 보이는 다른 표기(로어북 키워드)도 뺀다
    const me = getContext().name1;
    if (me) {
        const meLore = allLoreNames.filter(n => normName(n) === normName(me));
        const isMe = (n) => normName(n) === normName(me) || (meLore.length && guessSameAs(n, meLore.map(x => ({ name: x }))));
        for (let i = out.length - 1; i >= 0; i--) if (isMe(out[i].name)) out.splice(i, 1);
    }
    if (firstTime) {
        // 명단을 정하기 전에 이미 판정받던 캐릭터는 처음부터 체크
        for (const c of out) if (judged.includes(c.name)) c.on = true;
        // 로어북 키워드로 같은 사람으로 보이면(일본어 이름 ↔ 한국어 제목 등) 그 사람의 번역 전 이름으로 합친다
        for (const c of [...out]) {
            const same = guessSameAs(c.name, out);
            const target = same && out.find(o => o.name === same);
            if (!target || target === c) continue;
            for (const a of [c.name, ...c.aliases]) if (!target.aliases.some(x => normName(x) === normName(a))) target.aliases.push(a);
            target.on ||= c.on;
            out.splice(out.indexOf(c), 1);
        }
    }
    return out;
}

/**
 * 명단 저장: 번호는 한 번 붙으면 바뀌지 않는다 (뺀 캐릭터도 번호를 남겨 둬서 다시 넣으면 그대로)
 * @param {string[]} [removedNames] 이번에 × 로 지운 이름 @param {string[]} [restoredNames] 예전에 지웠다가 직접 다시 넣은 이름
 */
function castFromCandidates(cands, removedNames = [], restoredNames = []) {
    const old = getContext().chatMetadata?.pp_cast?.members || [];
    let nextId = old.reduce((a, m) => Math.max(a, m.id), 0) + 1;
    const members = old.map(m => ({ ...m, aliases: [], off: true }));
    for (const c of cands) {
        let m = members.find(x => normName(x.name) === normName(c.orig || c.name));
        if (!m) { m = { id: nextId++, name: c.name, aliases: [], start: 'unmet' }; members.push(m); }
        // 이름을 고쳤으면 예전 이름은 former에 남긴다 (그 이름으로 쌓인 기질·직접 고친 값·로어북 후보가 이 사람으로 이어지게)
        if (normName(m.name) !== normName(c.name)) {
            m.former = [...new Set([...(m.former || []), m.name])].filter(x => normName(x) !== normName(c.name));
            m.name = c.name;
        }
        m.off = !c.on;
        if (c.on) m.start = c.start === 'unmet' ? 'unmet' : Number(c.start);
        const seen = new Set([normName(c.name)]);
        for (const a of c.aliases || []) {
            const t = String(a).trim();
            if (t && !seen.has(normName(t))) { seen.add(normName(t)); m.aliases.push(t); }
        }
    }
    // 지운 사람: 번호는 그대로 두고(다시 넣으면 같은 번호) 명단에서는 뺀다
    const back = new Set(restoredNames.map(n => normName(n)));
    const gone = new Set([...removedCastNames(), ...removedNames.map(n => normName(n))].filter(n => !back.has(n)));
    for (const m of members) m.removed = gone.has(normName(m.name)) || undefined;
    const removed = [...new Set([...(getContext().chatMetadata?.pp_cast?.removed || []), ...removedNames])].filter(n => !back.has(normName(n)));
    return { version: 1, members, removed };
}

function buildTurns() {
    const chat = getContext().chat || [];
    const items = activeItems();
    // 캐릭터별 값을 쓰는 항목(호감도·속마음): 번호·별명을 명단 이름으로 맞춘다
    const gaugePerChar = new Set(items.filter(it => it.perChar).map(itemKey));
    const mindKeys = new Set(items.filter(it => it.type === 'mind').map(itemKey));
    const out = [];
    let pendingUser = [];
    chat.forEach((m, i) => {
        // 숨긴 메시지(/hide, 요약 확장)는 AI에게만 안 보낼 뿐 이야기의 일부라 그대로 읽는다.
        // 건너뛰는 건 실리태번이 만든 진짜 시스템 메시지(안내문 등)뿐이다.
        if (!m || isRealSystemMessage(m)) return;
        if (m.is_user) {
            const t = cleanText(m.extra?.display_text || m.mes).split(EXTRA_MARK).join('').trim();
            if (t) pendingUser.push(t);
            return;
        }
        // 번역 확장이 만든 번역본(display_text)이 있으면 그걸 보여준다 (TRANS로 원문 전환)
        const hasTrans = hasTranslation(m);
        const original = hasTrans && forceOriginal.has(`${i}:${Number(m.swipe_id ?? 0)}`);
        const shown = hasTrans && !original ? m.extra.display_text : m.mes;
        // 채팅창과 같은 정규식(표시용 포함)을 거친 글로 보여준다. 채팅창에서 숨긴 건 VN에서도 숨긴다
        const depth = chat.length - 1 - i;
        const display = (t) => { try { return getRegexedString(t, regex_placement.AI_OUTPUT, { isMarkdown: true, depth }); } catch { return t; } };
        const cgs = findCgs(m);
        // 갤러리(media)에 붙은 여러 장: AutoPic이 그림마다 남긴 원래 태그가 다르면 서로 다른 장면, 같으면 다시 그린 버전
        const scenes = mediaScenes(m, cgs);
        if (scenes) Object.assign(cgs, { list: scenes.list, index: scenes.list.length - 1, source: 'scenes', versions: scenes.versions, keys: scenes.keys });
        // AutoPic 그림이 글 사이에 여러 장이면, 그림 자리에 [cg:N] 표시를 넣어 VN이 그 문장에서 그림을 바꾼다
        const cgSeq = (cgs.source === 'slot' || cgs.source === 'img' || cgs.source === 'scenes') && cgs.list.length > 1;
        const markCg = (t) => !cgSeq ? t : String(t || '')
            .replace(/<(\w+)[^>]*data-autopic-slot=["']([a-zA-Z0-9-]+)["'][^>]*>[\s\S]*?<\/\1>/gi, (all, _tag, id) => {
                const src = (m.extra?.autopic_image_slots?.[id] || m.swipe_info?.[m.swipe_id ?? 0]?.extra?.autopic_image_slots?.[id])?.src;
                const k = cgs.list.indexOf(src);
                return k >= 0 ? `\n[cg:${k}]\n` : all;
            })
            .replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (all, src) => { const k = cgs.list.indexOf(src); return k >= 0 ? `\n[cg:${k}]\n` : all; });
        const shownHtml = display(markCg(shown));
        let lines = splitLines(shownHtml);
        // 원문+번역을 함께 보여주는 번역 설정이면 원문 줄은 뺀다
        if (shown !== m.mes) lines = dropOriginalLines(lines, splitLines(display(markCg(m.mes))));
        if (!lines.length && shown !== m.mes) lines = splitLines(display(markCg(m.mes)));
        // 정규식으로만 그려지는 상태창·버튼(코드 블록이 아닌 것)은 끝에 "정규식 읽기" 한 줄을 붙인다.
        // 정규식을 거친 글로 판단하고(채팅창에 안 그려진 오래된 턴도), 스크립트가 그리는 것은 채팅창을 본다
        if (lines.length && !lines.some(l => l.extra) && (htmlHasUi(shownHtml, lines) || hasExtraUi({ mesId: i }, lines))) lines.push(extraLine());
        // 글 속 위치를 모르는 여러 장(갤러리), 또는 마지막 그림이 끝부분(선택지 직전)에 몰려 거의 못 보는 경우:
        // 문장 수를 나눠 고르게 바꾼다 (2장이면 처음과 중간, 3장이면 처음·1/3·2/3)
        const marks = lines.map((l, p) => (l.cgAt != null ? p : -1)).filter(p => p >= 0);
        const lateMark = marks.length && marks[marks.length - 1] >= Math.max(1, lines.length * 0.75);
        if (cgSeq && lines.length && lateMark) lines = lines.map(({ cgAt, ...l }) => l);
        if (cgSeq && lines.length && !lines.some(l => l.cgAt != null)) {
            const n = cgs.list.length;
            for (let k = 0; k < n; k++) {
                const at = Math.min(lines.length - 1, Math.floor((k * lines.length) / n));
                if (lines[at].cgAt == null) lines[at] = { ...lines[at], cgAt: k };
            }
        }
        // 글 속 그림의 옛 버전(리롤 전 그림): 위치 표시를 다 단 뒤에, 보여 줄 버전으로 바꾼다
        const inline = inlineVersions(m, cgs);
        if (inline) Object.assign(cgs, { list: inline.shown, versions: inline.versions, keys: inline.keys });
        const cg = cgs.list[cgs.index] || '';
        // 본문이 사라진 답장(설계 메모만 남은 경우 등): 직전 턴에 묻혀 진행이 멈춘 것처럼 보이지 않게 안내 한 줄을 보여준다
        if (!lines.length && (pendingUser.length || String(m.mes || '').replace(/<[^>]*>/g, '').trim().length > 40)) {
            lines = [{ n: '', t: '이 답장은 본문이 비어 있어요. ↻ 버튼으로 다시 받아 보세요.' }];
        }
        // AutoPic "새 메시지" 모드: 이미지 전용 메시지는 직전 턴에 붙인다
        if (!lines.length) {
            const prev = out[out.length - 1];
            if (cg && prev && !pendingUser.length) {
                Object.assign(prev, { cg, cgs: cgs.list, cgIndex: cgs.index, cgSource: cgs.source, cgSeq, cgVersions: cgs.versions || null, cgSceneKeys: cgs.keys || null, cgMesId: i });
                for (const f of readFavs(m, cg)) prev.favs.add(f);
            }
            return;
        }
        // 이름표: 명단 사람의 다른 표기(번역 안 된 이름 등)면 명단 이름으로 보여 준다
        lines = lines.map(l => (l.n ? { ...l, n: speakerName(l.n) } : l));
        // 번역본에 <pickplay> 블록이 살아 있으면 번역된 값을, 없으면 원문 값을 쓴다
        const ppShown = shown !== m.mes ? parseMessagePp(shown) : null;
        const ppRaw = parseMessagePp(m.mes);
        const pp = {
            // 캐릭터별 호감도는 번호(또는 이름)를 명단 이름으로 바꾸고, 명단 밖은 버린다
            status: (ppShown?.status.length ? ppShown.status : ppRaw.status)
                .map((u) => {
                    if (!u.name || !gaugePerChar.has(u.key)) return u;
                    // 속마음은 호감도를 안 쌓는 사람도 명단 이름으로 모으고, 명단 밖 이름도 버리지 않는다
                    const n = mindKeys.has(u.key) ? mindName(u.name) : castName(u.name);
                    return n ? { ...u, name: n } : null;
                })
                .filter(Boolean),
            // 코멘트·내레이터 메시지에는 선택지가 없으니 직전 답장의 선택지를 그대로 둔다
            choices: (ppShown?.choices.length ? ppShown.choices : ppRaw.choices).length
                ? (ppShown?.choices.length ? ppShown.choices : ppRaw.choices)
                : (NOTE_TYPES.has(m.extra?.type) ? out[out.length - 1]?.pp.choices || [] : []),
            fx: ppRaw.fx,
            transition: ppRaw.transition,
            tone: ppRaw.tone,
            bgm: ppRaw.bgm,
            errors: ppRaw.errors,
        };
        // BGM은 바꾸라는 줄이 나올 때까지 앞 턴의 곡을 이어 간다
        const bgm = pp.bgm ? (isStopWord(pp.bgm) ? '' : pp.bgm) : (out[out.length - 1]?.bgm || '');
        const present = new Set(lines.map(l => l.n && castName(l.n)).filter(Boolean));
        for (const u of pp.status) {
            if (!u.name || !gaugePerChar.has(u.key)) continue;
            // 속마음만 쓴 사람도 이번 장면에 나온 것 (호감도 명단에 있는 사람만)
            const n = mindKeys.has(u.key) ? castName(u.name) : u.name;
            if (n) present.add(n);
        }
        // 속마음은 호감도를 안 쌓는 사람까지 이번 장면에 나온 사람 전부
        const presentMind = new Set(lines.map(l => l.n && mindName(l.n)).filter(Boolean));
        for (const u of pp.status) if (u.name && mindKeys.has(u.key)) presentMind.add(u.name);
        out.push({
            mesId: i,
            swipeId: Number(m.swipe_id ?? 0),
            swipeCount: Array.isArray(m.swipes) ? m.swipes.length : 1,
            user: pendingUser.join(' / '),
            lines,
            cg,
            cgs: cgs.list,
            cgIndex: cgs.index,
            cgSource: cgs.source,
            cgSeq,
            cgVersions: cgs.versions || null,
            cgSceneKeys: cgs.keys || null,
            cgMesId: i,
            favs: readFavs(m, cg),
            pp,
            bgm,
            hidden: !!m.is_system,
            override: castOverride(m.extra?.pp_user),
            present: [...present],
            presentMind: [...presentMind],
            canSwipe: false,
            trans: { has: hasTrans, original },
        });
        pendingUser = [];
    });
    const last = out[out.length - 1];
    // 다시 쓰기·스와이프는 AI 답장에만 (코멘트·내레이터 메시지는 제외)
    if (last && last.mesId === chat.length - 1 && !NOTE_TYPES.has(chat[last.mesId]?.extra?.type)) last.canSwipe = true;
    foldStates(out, items, initialState(), affinityRules());
    return out;
}

/** 마지막 턴이 바뀌었는지 판단하는 키 (이미지 전용 메시지나 유저 메시지로는 바뀌지 않는다) */
function turnKey() {
    const t = turns[turns.length - 1];
    return `${getContext().chatId}:${t?.mesId ?? -1}:${t?.swipeId ?? 0}`;
}

function scheduleRebuild(follow = 'keep') {
    if (follow === 'latest') pendingFollow = 'latest';
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 60);
}

/** 켜 둔 상태라도 채팅방에 들어가 있을 때만 화면을 덮는다 (새로고침 직후 첫 화면 등) */
function syncActive() {
    document.body.classList.toggle('pp-active', !!engine && !!getContext().chatId);
}

function rebuild() {
    const follow = pendingFollow;
    pendingFollow = 'keep';
    turns = buildTurns();
    updatePrompt();
    if (!engine) return;
    syncActive();
    const key = turnKey();
    const changed = key !== lastKey;
    lastKey = key;
    engine.setItems(activeItems());
    engine.setTurns(turns, follow === 'latest' || changed ? 'latest' : 'keep');
    updateTranslating();
    if (pendingGenerationEnd) {
        pendingGenerationEnd = false;
        engine.setGenerating(false);
    }
    // 그림이 다 나왔으면 미뤄 둔 답장 알림을 울린다
    checkReadySound();
}

// ───────── 로어북 캐릭터 목록 ─────────

async function refreshNames() {
    try {
        const entries = await getSortedEntries();
        const names = [];
        loreMeta = new Map();
        loreKeys = new Map();
        for (const e of entries || []) {
            if (e.disable) continue;
            const raw = String(e.comment || (Array.isArray(e.key) ? e.key[0] : '') || '').trim();
            // "■ 김민수", "[캐릭터] 이서연"처럼 제목 앞의 분류 기호·[분류]는 뗀다
            const BULLETS = /^[■□▪▫●○◆◇◈▶▷►▸•・·※★☆\-–—>\s]+/;
            const n = raw.replace(BULLETS, '').replace(/^\[[^\]]*\]\s*/, '').replace(BULLETS, '').trim() || raw;
            if (!n || names.includes(n)) continue;
            names.push(n);
            loreMeta.set(n, isLikelyPerson(e, raw));
            loreKeys.set(n, Array.isArray(e.key) ? e.key.filter(Boolean).map(String) : []);
        }
        allLoreNames = names;
    } catch (err) {
        console.warn('[PickPlay] 로어북을 읽지 못했어요', err);
        allLoreNames = [];
        loreMeta = new Map();
    }
    updateRegistered();
}

// 내용 속 인물 단서: 이름·성별·나이·키·외모 같은 프로필 항목 (영어·한국어·일본어)
const PERSON_HINT_RE = /(\b(?:name|sex|gender|appearance|personality|occupation)\s*[:：]|\bbasic\s+profile\b|\b\d(?:st|nd|rd|th)\s+year\b|\bage\s*[:：]?\s*\d|\b(?:fe)?male\b|\b(?:early|mid|late)\s+\d0s\b|\byears?\s+old\b|\b\d{1,2}\s*(?:yo|y\/o)\b|\b1[4-9]\d(?:\.\d)?\s*cm\b|성별|나이|외모|성격|남성|여성|\d{1,2}\s*(?:세|살)(?![가-힣])|\d\s*학년|이름\s*[:：]|名前|性別|年齢|性格|外見|容姿|身長|\d{1,2}\s*歳|男性|女性|[高中]校\s*\d\s*年生)/i;

/**
 * 로어북 항목이 인물인지 추정한다.
 * 인물 아님: [시스템]·[설정] 같은 분류의 항목, 키워드 없이 항상 켜졌는데 인물 정보도 없는 항목(규칙·설정), 내용에 이름·성별·나이·키 같은 인물 정보가 없는 항목.
 * (키워드 없이 항상 켜진 캐릭터 항목도 있어서, 항상 켜짐만으로 인물이 아니라고 하지 않는다)
 */
function isLikelyPerson(entry, rawTitle) {
    // 제목의 [분류]: [시스템]·[설정] 같은 건 인물 아님, [캐릭터]·[인물]은 인물, 그 밖([👼] 등)은 내용으로 판단
    const tag = (String(rawTitle).match(/^\s*[■□▪▫●○◆◇◈▶▷►▸•・·※★☆\s]*\[([^\]]*)\]/) || [])[1] || '';
    if (/시스템|system|설정|setting|상시|세계|world|규칙|rule|인포|info|상태|lore|format|출력/i.test(tag)) return false;
    if (/캐릭터|인물|character|char|npc/i.test(tag)) return true;
    // 서로 다른 인물 단서 수. 키워드 없이 항상 켜진 항목(규칙·설정이 흔함)은 단서가 2개 이상이어야 인물로 본다
    const hits = new Set((String(entry.content || '').match(new RegExp(PERSON_HINT_RE.source, 'gi')) || []).map(s => s.toLowerCase().replace(/\d+/g, '#')));
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    return hits.size >= (entry.constant && !keys.length ? 2 : 1);
}

/** 로어북 이름이 인물로 보이는지 (명단 후보·호감도 "전체" 목록) */
function isShownLoreName(n) {
    return !!loreMeta.get(n);
}

/** 호감도 "전체" 목록: 로어북의 인물 */
function updateRegistered() {
    registered = allLoreNames.filter(isShownLoreName);
    engine?.renderStatus();
}

// ───────── 캐릭터 기질 (자동 생성) ─────────

function hasCharacter() {
    const ctx = getContext();
    return ctx.characterId !== undefined || !!ctx.groupId;
}

/** 기질 만들기의 "읽을 자료" 후보: 이 채팅에 연결된 로어북 항목 전부 */
async function loreEntries() {
    try {
        const entries = await getSortedEntries();
        return (entries || []).filter(e => !e.disable && e.content).map((e, i) => ({
            id: `${e.world ?? ''}:${e.uid ?? i}`,
            title: String(e.comment || (Array.isArray(e.key) ? e.key.join(', ') : '') || '항목'),
            content: String(e.content),
            keys: Array.isArray(e.key) ? e.key.filter(Boolean).map(String) : [],
        }));
    } catch {
        return [];
    }
}

/** 로어북 항목이 이 이름들 중 누군가의 항목으로 보이는지 (제목·키워드). 자료 고르기에서 미리 체크할 때만 쓴다 */
function loreMatchesName(e, names) {
    const title = normName(e.title);
    const keys = e.keys.map(normName).filter(k => k.length >= 2);
    return names.some((raw) => {
        const n = normName(raw);
        return n.length >= 2 && (title.includes(n) || keys.some(k => k === n || k.includes(n) || n.includes(k)));
    });
}

function cardFields() {
    const ctx = getContext();
    let f = {};
    try { f = ctx.getCharacterCardFields() || {}; } catch { /* 그룹 등 */ }
    return { name: ctx.name2, description: f.description, personality: f.personality };
}

/** 명단을 처음 정할 때 미리 체크할 캐릭터: 로어북의 인물(숨기지 않은 것), 인물이 없으면 카드 캐릭터 */
function traitNames() {
    const names = allLoreNames.filter(isShownLoreName);
    if (!names.length && getContext().name2) names.push(getContext().name2);
    return names;
}

/**
 * 캐릭터 기질 만들기. 유저가 "이 채팅 상태창"의 "기질 만들기"에서 누를 때만 지금 연결된 API로 한 번 요청한다.
 * 만든 기질은 이 채팅과 카드 양쪽에 저장한다 (같은 카드의 새 채팅은 다시 만들지 않고 쓴다)
 * @param {{names: string[], entries: Array<{title: string, content: string}>, useCard: boolean}} p
 * @returns {Promise<boolean>}
 */
async function generateTraits({ names, entries, useCard }) {
    if (traitsBusy || !names.length) return false;
    const token = ++traitsToken;
    const chatId = getContext().chatId;
    const key = cardKey();
    traitsBusy = true;
    try {
        const { system, prompt } = buildTraitsPrompt({ names, card: useCard ? cardFields() : null, lore: entries });
        const text = await generateRaw({ prompt, systemPrompt: system, responseLength: 2048, trimNames: false });
        if (token !== traitsToken || getContext().chatId !== chatId) return false;
        const made = parseTraits(parseJsonLoose(text), names);
        // 사람마다 속도만 바꾸고 유저가 적은 판정 메모는 남긴다
        const mergeInto = (base) => {
            const next = structuredClone(base || {});
            for (const [n, v] of Object.entries(made)) next[n] = { ...next[n], ...v };
            return next;
        };
        await saveTraits(mergeInto(traits()));
        if (key) {
            settings().cardTraits ??= {};
            settings().cardTraits[key] = mergeInto(settings().cardTraits[key]);
            saveSettingsDebounced();
        }
        toastr.success(`${Object.keys(made).length}명의 속도를 분석했어요`, '픽플레이');
        return true;
    } catch (err) {
        console.warn('[PickPlay] 속도를 분석하지 못했어요', err);
        toastr.error('속도를 분석하지 못했어요', '픽플레이');
        return false;
    } finally {
        if (token === traitsToken) traitsBusy = false;
    }
}

/** 공략 정보에서 고칠 때: 이 채팅에만 저장한다 (카드에서 가져온 기질·예전 게임 모드 데이터도 이 채팅 것으로 옮긴다) */
async function saveTraits(next) {
    const md = getContext().chatMetadata;
    if (!md) return;
    md.pp_traits = { version: 1, createdAt: md.pp_traits?.createdAt || Date.now(), traits: next };
    await getContext().saveMetadata();
    scheduleRebuild('keep');
}

function formatGauge(item, name, v) {
    if (!item.perChar || settings().affinityDisplay === 'number') return Math.round(v);
    return tierOf(v).label;
}

// ───────── 프롬프트 주입 ─────────

/** 판정형 호감도 규칙. 기질이 없는 캐릭터는 배율 1 */
function affinityRules() {
    const tr = traits() || {};
    // 기질은 로어북 이름으로 만들어져서, 명단 이름(별칭 포함)으로도 찾는다
    const trOf = (n) => tr[n] ?? Object.entries(tr).find(([k]) => castName(k) === n)?.[1];
    return {
        grades: AFFINITY.grades,
        gain: (n) => trOf(n)?.gain ?? 1,
        loss: (n) => trOf(n)?.loss ?? 1,
        speed: 1,
        start: startValue(),
        slow: (v) => {
            const i = AFFINITY.tiers.indexOf(tierOf(v));
            const s = AFFINITY.slowdown;
            return s[Math.min(i, s.length - 1)] ?? 1;
        },
        cap: AFFINITY.cap,
        window: AFFINITY.window,
    };
}

/**
 * AI에게 알려줄 현재 상태. 캐릭터별 호감도는 숫자 대신 단계로만 알려준다
 * (숫자가 높은 캐릭터에게 이야기가 쏠리는 것을 줄이려고).
 */
function statusLine(state) {
    const parts = [];
    for (const it of activeItems()) {
        const k = itemKey(it);
        // 속마음은 매 턴 새로 쓰는 것이라 지난 값을 다시 보내지 않는다
        if (it.type === 'mind') continue;
        if (it.type !== 'gauge') {
            if (state.text[k]) parts.push(`${k}=${state.text[k]}`);
        } else if (it.perChar) {
            for (const [n, v] of Object.entries(state.gauge[k] || {})) {
                const id = memberOf(n)?.id;
                parts.push(`${k}.${id ?? n}=${tierOf(v).label}`);
            }
        } else if (state.gauge[k]?._ != null) {
            parts.push(`${k}=${state.gauge[k]._}`);
        }
    }
    return parts.join(' | ');
}

function formatExample(items) {
    const parts = items.map((it) => {
        const k = itemKey(it);
        // 예시 글은 영어 자리 표시로 둔다 (한국어로 두면 다른 언어로 플레이할 때 그 글이 섞여 나온다)
        if (it.type === 'mind') return `${k}.${castMembers() ? 'N' : 'Name'}=(kaomoji) inner thought`;
        if (it.type !== 'gauge') return `${k}=…`;
        // 예시를 +로 두면 AI가 따라서 매번 +를 준다. 판정이 있을 때만 쓰는 칸임을 보여주는 grade로
        return it.perChar ? `${k}.${castMembers() ? 'N' : 'Name'}=grade` : `${k}=+2`;
    });
    const status = parts.length ? `status: ${parts.join(' | ')}\n` : '';
    const choice = settings().choices !== false ? 'choice: option 1 | option 2 | option 3\n' : '';
    return `<pickplay>\n${status}${choice}</pickplay>`;
}

/** 호감도 판정 기준과 캐릭터별 취향 (플레이어에게는 보이지 않음) */
function judgingLines(items) {
    const aff = items.find(it => it.type === 'gauge' && it.perChar);
    if (!aff) return [];
    const k = itemKey(aff);
    // 유저가 적은 판정 메모. 저장 이름이 분석 때의 이름일 수 있어서 명단의 지금 이름으로 알려 준다
    const notes = Object.entries(traits() || {}).filter(([, t]) => String(t?.memo || '').trim())
        .map(([n, t]) => `- ${castName(n) || n}: ${String(t.memo).trim().replace(/\s*\n\s*/g, ' ')}`);
    // 명단 채팅: 이름 대신 번호로 판정하게 한다 (번역·표기가 달라도 같은 사람으로 모인다)
    const cast = castMembers() ? activeCast() : null;
    const who = cast ? 'N' : 'Name';
    return [
        ...(cast ? [`Characters tracked by ${k}, by number: ${cast.map(m => `${m.id}=${m.name}`).join(', ')}. Write the number, never the name. Do not judge anyone who is not on this list.`] : []),
        `Relationship judging for ${k} (hidden from the player): write ${k}.${who}= one of ++, +, 0, -, -- only for a character whose feelings toward {{user}} changed this turn. Never write points. If nobody changed, leave ${k} out of status entirely.`,
        '- Judge what {{user}} did this turn, not the mood of the scene. A character being friendly, chatty, or helpful on their own is 0. A pleasant scene is 0.',
        '- + only when {{user}}\'s own words or actions this turn earned it. ++ rare: a moment that truly moves them. - mild annoyance or awkwardness. -- real offense or hurt.',
        '- Judge by how this character would actually feel, based on their character sheet, not by general manners. Leave out characters who did not interact.',
        ...(notes.length ? ['Player notes on characters (follow these when judging; they override your own reading):', ...notes] : []),
    ];
}

// ───────── 채팅 화면에만 그려지는 것 (정규식 상태창·QR 버튼 등) ─────────

/** 이런 요소가 있으면 VN 문장으로 못 옮기는 화면(카드·표·버튼·iframe)이 있다고 본다 */
const EXTRA_UI_SELECTOR = 'div, table, details, section, button, iframe, ul, ol, fieldset, svg, canvas, form, input, select, textarea';
/** 그림·그림 조작 버튼은 VN이 CG로 따로 보여 주니 세지 않고, 복사본에서도 뺀다 */
const IMAGE_PARTS = 'img, .autopic-tag-img-wrapper, .autopic-tag-controls, .autopic-image-slot, [data-autopic-slot], .mes_img_container';

/** 실리태번 채팅창에 지금 그려진 그 턴의 본문 (오래된 턴은 그려져 있지 않을 수 있다) */
function renderedMesText(t) {
    return t ? document.querySelector(`#chat .mes[mesid="${t.mesId}"] .mes_text`) : null;
}

/** 번역·읽기 도우미 확장이 본문 안에 붙이는 진행 표시·단추 등. 화면으로 세지 않는다 */
const NOT_UI = `${IMAGE_PARTS}, [class*="translat" i], [class*="llmt" i], [class*="progress" i], [class*="reasoning" i], [class*="tts" i], .code-copy`;
/** 글이 없어도 화면으로 보는 것 */
const WIDGET = 'iframe, canvas, input, select, textarea, button, svg';
/** 글자·숫자만 남겨 비교 (따옴표·빈칸·이름표 모양이 달라도 같은 글로 본다) */
const bare = (v) => String(v || '').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 채팅창 본문에서 VN 문장으로 못 옮기는 화면(정규식 상태창·iframe·버튼 등).
 * 테마·확장이 본문 문단을 div로 감싼 것(글이 VN 문장과 같음)이나 번역 진행 표시는 빼고 센다
 * @param {Element} src 채팅창 .mes_text @param {Array<{n?:string,t:string}>} lines 그 턴의 VN 문장
 */
function extraUiParts(src, lines) {
    const story = bare((lines || []).map(l => `${l.n || ''}${l.t || ''}`).join(''));
    return [...src.querySelectorAll(EXTRA_UI_SELECTOR)].filter((n) => {
        if (n.hidden || n.closest(NOT_UI)) return false;
        if (n.matches(WIDGET) || [...n.querySelectorAll(WIDGET)].some(w => !w.closest(NOT_UI))) return true;
        const text = bare(n.textContent);
        return !!text && !story.includes(text);
    });
}

/** 그 턴에 채팅창에서만 보이는 화면(정규식 상태창·JS-Slash-Runner iframe·QR 버튼 등)이 있는지 */
function hasExtraUi(t, lines = t?.lines) {
    const src = renderedMesText(t);
    return !!src && extraUiParts(src, lines).length > 0;
}

/** 정규식(표시용)을 거친 글에 화면(카드·표·버튼 등)이 들어 있는지. 채팅창에 안 그려진 턴도 알 수 있다 */
const UI_TAG_RE = new RegExp(`<(${EXTRA_UI_SELECTOR.split(/\s*,\s*/).join('|')})\\b`, 'i');
const htmlUiCache = new Map();
function htmlHasUi(html, lines) {
    const s = stripHiddenBlocks(html);
    if (!UI_TAG_RE.test(s)) return false;
    const key = s + '\u0001' + lines.length;
    if (!htmlUiCache.has(key)) {
        if (htmlUiCache.size > 300) htmlUiCache.clear();
        // DOMParser 문서는 그림을 불러오거나 스크립트를 돌리지 않는다
        const body = new DOMParser().parseFromString(s, 'text/html').body;
        htmlUiCache.set(key, extraUiParts(body, lines).length > 0);
    }
    return htmlUiCache.get(key);
}

/**
 * TEXT 창 끝과 "정규식 읽기" 창에 넣을 복사본. 정규식·스크립트가 그린 결과를 그대로 가져온다.
 * 본문 글(문단)은 VN 문장으로 이미 보이니 빼고, 카드·iframe 같은 화면만 남긴다
 */
function extraUiNode(t, k = null) {
    const src = renderedMesText(t);
    const parts = src ? extraUiParts(src, t.lines) : [];
    if (!parts.length) return null;
    // 화면이 들어 있는 맨 위 칸들
    let groups = [...src.children].filter(child => parts.some(p => child === p || child.contains(p)));
    // k = 그 턴의 몇 번째 "정규식 읽기" 줄인지. 칸 수와 줄 수가 같으면 그 자리 것만 (문장 사이에 정규식이 여러 개일 때)
    const marks = (t.lines || []).filter(l => l.extra).length;
    // 수가 안 맞으면 전부를 첫 번째 줄 자리에 (나머지 줄은 null → 같은 화면이 여러 번 나오지 않게)
    if (k != null && groups.length === marks && groups[k]) groups = [groups[k]];
    else if (k > 0) return null;
    const node = document.createElement('div');
    for (const child of groups) node.append(child.cloneNode(true));
    node.querySelectorAll(NOT_UI).forEach(n => n.remove());
    // iframe은 복사하면 새로 그려진다. 높이는 원래 크기 그대로, id는 겹치지 않게 뺀다
    const origFrames = groups.flatMap(g => [...(g.matches('iframe') ? [g] : []), ...g.querySelectorAll('iframe')]).filter(f => !f.closest(NOT_UI));
    node.querySelectorAll('iframe').forEach((f, i) => {
        const h = origFrames[i]?.offsetHeight;
        const w = origFrames[i]?.offsetWidth;
        f.removeAttribute('id');
        // 늦게 불러오기(lazy)면 창 안 스크롤 칸에서 안 불러와지는 경우가 있다
        f.removeAttribute('loading');
        // 폭은 채팅창에서의 폭 그대로(창보다 넓으면 창 폭). 100%로 두면 크기에 맞춰 줄어드는 정규식 읽기 창에서 300px로 쪼그라든다
        f.style.width = w > 50 ? `${w}px` : '100%';
        f.style.maxWidth = '100%';
        f.style.height = `${h > 20 ? h : 400}px`;
    });
    return node;
}

// ───────── 이어 보기 (문장 위치) ─────────

const RESUME_KEY = 'pp_resume:';

/** 마지막 턴에서 보던 문장. 기기마다 브라우저에 저장한다 */
function resumePage(t) {
    try {
        const r = JSON.parse(localStorage.getItem(RESUME_KEY + getContext().chatId) || 'null');
        return r && r.mesId === t?.mesId && r.swipeId === t?.swipeId ? Number(r.page) || 0 : 0;
    } catch { return 0; }
}

let lastResume = '';
function savePosition(t, page) {
    const chatId = getContext().chatId;
    if (!chatId || !t) return;
    const v = JSON.stringify({ mesId: t.mesId, swipeId: t.swipeId, page });
    if (v === lastResume) return;
    lastResume = v;
    try { localStorage.setItem(RESUME_KEY + chatId, v); } catch { /* 저장소가 막혀도 VN은 그대로 */ }
}

// ───────── BGM · 효과음 ─────────

const sound = new PPSound();
/** AI에게 알려 줄 이름 수 상한 (프롬프트가 길어지지 않게) */
const SOUND_PROMPT_MAX = 40;

/** 설정에서 켰고 폴더에 파일이 하나라도 있으면 true (VN 화면의 SOUND 버튼도 이때만) */
function soundAvailable() {
    return !!settings().sound && sound.hasFiles();
}

function applySound() {
    const s = settings();
    sound.configure({ enabled: s.sound && !!engine, muted: s.soundMuted, bgmVolume: s.bgmVolume, sfxVolume: s.sfxVolume });
}

/** assets/bgm(BGM) · assets/ambient(효과음) 폴더의 파일 목록을 다시 읽는다 */
async function loadSoundFiles() {
    try {
        const res = await fetch('/api/assets/get', { method: 'POST', headers: getRequestHeaders() });
        const data = res.ok ? await res.json() : {};
        sound.setFiles({ bgm: data.bgm || [], sfx: data.ambient || [] });
    } catch (err) {
        console.warn('[PickPlay] 소리 파일 목록을 읽지 못했어요', err);
    }
    renderSoundInfo();
    engine?.renderMenu();
    updatePrompt();
}

function bgmPromptLines() {
    const names = soundAvailable() ? sound.names('bgm').slice(0, SOUND_PROMPT_MAX) : [];
    if (!names.length) return [];
    const now = turns[turns.length - 1]?.bgm;
    return [
        // 아직 아무것도 안 틀었으면 이번 답장에 고르게 한다 ("분위기가 바뀔 때만"이면 AI가 처음부터 안 쓴다)
        now
            ? `- bgm (its own line in the block): background music, now playing: ${now}. It keeps playing across replies, so write bgm only when the mood clearly shifts, choosing one exact name from: ${names.join(', ')}. Write stop for silence.`
            : `- bgm (its own line in the block): background music. Nothing is playing yet, so write one in this reply, choosing the exact name that fits the scene from: ${names.join(', ')}. It keeps playing across replies until you change it.`,
    ];
}

function sfxPromptLines() {
    const names = soundAvailable() ? sound.names('sfx').slice(0, SOUND_PROMPT_MAX) : [];
    if (!names.length) return [];
    return [
        `Sound effects (optional, at most 1-2 per reply): put [sfx:NAME] at the start of the line where the sound happens, choosing one exact name from: ${names.join(', ')}.`,
    ];
}

/**
 * 폴더 위치를 실리태번 폴더 기준 경로로 복사해 알려 준다.
 * 브라우저는 컴퓨터 폴더를 직접 열 수 없고, 파일은 ST가 돌아가는 기기(PC 또는 Termux)에 있다
 * @param {'bgm'|'sfx'} kind
 */
async function copyFolderPath(kind) {
    const rel = `data\\${getCurrentUserHandle()}\\assets\\${kind === 'bgm' ? 'bgm' : 'ambient'}\\`;
    try { await navigator.clipboard.writeText(rel); } catch { /* 복사가 막혀도 경로는 보여 준다 */ }
    const tip = '실리태번 폴더 안의 이 위치에 파일을 넣고 설정에서 "다시 찾기"를 누르세요.';
    toastr.info(`${rel}\n${tip}`, '경로를 복사했어요', { timeOut: 8000 });
}

/** 설정 화면의 파일 수 안내 */
function renderSoundInfo() {
    const n = { bgm: sound.names('bgm').length, sfx: sound.names('sfx').length };
    $('#pp_sound_count').text(`BGM ${n.bgm}곡 · 효과음 ${n.sfx}개`);
    $('#pp_bgm_path').text(`data\\${getCurrentUserHandle()}\\assets\\bgm`);
    $('#pp_sfx_path').text(`data\\${getCurrentUserHandle()}\\assets\\ambient`);
}

/**
 * AI에게 보내는 지시의 틀. 사용자가 설정의 "프롬프트" 탭에서 고칠 수 있다.
 * {{pp_…}} 자리는 설정·채팅 상태에 맞춰 채워지고, 넣을 내용이 없으면 그 줄째 빠진다.
 * ({{user}}·{{char}}는 실리태번이 채운다)
 */
export const DEFAULT_PROMPT_TEMPLATE = [
    '<pickplay_format>',
    'This chat is shown on a visual novel screen. Format every reply as follows.',
    '- Follow this format from this reply on, even if earlier replies in this chat do not.',
    '- Dialogue: one line per utterance, written as `Name: dialogue`. Lines without a name are narration.',
    '{{pp_length}}',
    '- Put the status block shown below at the very end of the reply. Any image blocks belong inside the story, right after the paragraph they illustrate, never after this status block:',
    '{{pp_block_example}}',
    'Rules for the status block:',
    '{{pp_status_rule}}',
    '- choice: 2 to 4 short options for {{user}}\'s next action, written in the reply\'s language.',
    '{{pp_transition}}',
    '{{pp_bgm}}',
    '- Write nothing after the status block except the image block. Do not mention these block tags anywhere else in the reply.',
    '{{pp_affinity}}',
    '{{pp_effects}}',
    '{{pp_sfx}}',
    '{{pp_status_now}}',
    '</pickplay_format>',
].join('\n');

/** 틀의 {{pp_…}} 자리마다 들어갈 줄들 (설정 화면 안내에도 쓴다) */
function promptParts(state) {
    const items = activeItems();
    const kind = (it) => it.type === 'mind' ? 'per character: one kaomoji + one short inner thought' : it.type === 'gauge' ? (it.perChar ? 'relationship, judged per character' : '0-100 gauge') : 'short text';
    const desc = items.map(it => `${itemKey(it)} (${kind(it)})`).join(', ');
    const mind = items.find(it => it.type === 'mind');
    const cur = statusLine(state);
    const fx = !!settings().screenFx;
    return {
        pp_length: REPLY_LENGTH[settings().replyLength] ? ['- Length: ' + REPLY_LENGTH[settings().replyLength]] : [],
        pp_block_example: [formatExample(items)],
        pp_status_rule: items.length ? [
            '- status: include only the items whose value changed this turn. Text items take a short value. Per-character relationship items take a judgment (see below). Other gauges take +N or -N.',
            ...(mind ? [`- ${itemKey(mind)}: write it every reply for each character who appears in this reply: one kaomoji, then one short inner thought (what they really feel but do not say), in the reply's language. Skip characters who do not appear.`] : []),
            ...(mind && castMembers() ? [`- For ${itemKey(mind)}, write the character's number instead of the name: ${castMembers().map(m => `${m.id}=${m.name}`).join(', ')}. Write it only for characters on this list; skip anyone else (the screen shows only this list).`] : []),
        ] : [],
        // 화면효과를 끈 사람에게는 전환·톤·효과 표시 지시를 보내지 않는다
        pp_transition: fx ? [
            '- transition (optional, its own line in the block): fade when the scene or time jumps, whiteout when entering a dream or memory. Leave it out otherwise.',
            '- tone (optional): flashback when the whole reply is a flashback or dream.',
        ] : [],
        pp_bgm: bgmPromptLines(),
        pp_affinity: judgingLines(items),
        pp_effects: fx ? [
            'Screen effects (optional, at most 1-2 per reply, only at strong moments): put [fx:NAME] at the start of the line where it happens. Pick the one that fits the moment; shaking is only for physical impact.',
            '- shake: a crash, a slam, a fall · sway: dizziness, staggering, being shaken by someone · flash: a sudden realization, a shock, lightning, a camera shutter.',
            '- Example: [fx:flash]Name: (a shocked line)',
        ] : [],
        pp_sfx: sfxPromptLines(),
        pp_status_now: items.length ? [
            `Status items: ${desc}`,
            cur ? `Current status: ${cur}` : 'Current status: not set yet. Set every text item in this reply.',
        ] : [],
    };
}

function buildPrompt(state) {
    const parts = promptParts(state);
    const template = String(settings().promptTemplate || '').trim() || DEFAULT_PROMPT_TEMPLATE;
    const out = [];
    for (const line of template.split('\n')) {
        // 한 줄 전체가 자리 표시면 여러 줄로 바꾸고, 비면 줄째 뺀다
        const whole = line.trim().match(/^\{\{(pp_\w+)\}\}$/);
        if (whole && parts[whole[1]]) { out.push(...parts[whole[1]]); continue; }
        out.push(line.replace(/\{\{(pp_\w+)\}\}/g, (m, k) => parts[k] ? parts[k].join(' ') : m));
    }
    // 선택지를 끄면 선택지 규칙 줄을 뺀다 (틀을 고친 사용자 것에서도)
    return (settings().choices !== false ? out : out.filter(l => !/^\s*-\s*choice\s*:/i.test(l))).join('\n');
}

/** 설정 화면 미리보기: 지금 채팅 기준으로 실제로 보내는 지시 */
function currentPromptText() {
    const state = turns.length ? turns[turns.length - 1].state : emptyState(activeItems());
    return buildPrompt(state);
}

/** @param {number} [excludeMesId] 다시 생성 중인 메시지 (그 턴의 상태 변화는 기준에서 뺀다) */
function updatePrompt(excludeMesId = -1) {
    // 설정의 "실제로 보내는 내용"도 같이 갱신 (화면효과·BGM 등을 바꾸면 바로 보이게)
    const preview = document.getElementById('pp_prompt_preview');
    if (preview) preview.value = currentPromptText();
    if (!settings().enabled) {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const list = turns.filter(t => t.mesId !== excludeMesId);
    const state = list.length ? list[list.length - 1].state : emptyState(activeItems());
    // 대화 맨 끝(깊이 0)에 둔다. 깊이 1이면 직전 답변 앞에 놓여서, 앞 답변들이 형식을 안 지킨 채팅에서는
    // 모델이 지시보다 바로 앞 답변의 모양을 따라 썼다
    setExtensionPrompt(PROMPT_KEY, buildPrompt(state), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

// ───────── 프롬프트 정리 ─────────

/** 형식 예시로 남겨 둘 최근 답변 수. 그보다 오래된 답변의 <pickplay> 블록은 보내지 않는다 */
const KEEP_PP_BLOCKS = 2;
const PP_BLOCK_RE = /\n?<pickplay\b[^>]*>[\s\S]*?(?:<\/pickplay>|$)/gi;
const FX_MARK_TEST = /\[\s*(?:fx|효과|sfx|se|효과음)\s*[:：]/i;
const FX_MARK_STRIP = /\[\s*(?:fx|효과|sfx|se|효과음)\s*[:：][^\]]*\]/gi;

/**
 * 지난 답변의 <pickplay> 블록은 이미 상태로 계산돼 매 턴 "현재 상태"로 다시 알려주므로,
 * 대화 기록에 계속 남겨 보내면 토큰만 쌓인다. 채팅 원본은 두고 보내는 프롬프트에서만 뺀다.
 * 픽플레이를 끈 상태면 지시가 없으니 전부 뺀다.
 */
function stripOldPpBlocks(eventData) {
    const msgs = eventData?.chat;
    if (!Array.isArray(msgs)) return;
    let keep = settings().enabled ? KEEP_PP_BLOCKS : 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role !== 'assistant') continue;
        const has = (s) => typeof s === 'string' && (/<pickplay\b/i.test(s) || FX_MARK_TEST.test(s));
        const strip = (s) => s.replace(PP_BLOCK_RE, '').replace(FX_MARK_STRIP, '').replace(/\s+$/, '');
        if (typeof msg.content === 'string') {
            if (!has(msg.content)) continue;
            if (keep > 0) { keep--; continue; }
            msg.content = strip(msg.content);
        } else if (Array.isArray(msg.content)) {
            const parts = msg.content.filter(p => p?.type === 'text' && has(p.text));
            if (!parts.length) continue;
            if (keep > 0) { keep--; continue; }
            for (const p of parts) p.text = strip(p.text);
        }
    }
}

// ───────── 엔진 동작 → 실리태번 ─────────

// ───────── 다음 전개 (이번 답장 한 번만) ─────────
const DIRECTION_KEY = 'PICKPLAY_DIRECTION';
/** 다음 전개 지시가 걸린 생성이 시작됐는지. 끝나면 지시를 지운다 */
let directionArmed = false;
let directionUsed = false;

/**
 * 이번 답장 한 번에만 붙는 지시.
 * @param {string} text 전개 지시
 * @param {boolean} [carryOn] 내 말 없이(빈칸) 이어 쓰기: 직전 답장을 되풀이하지 말고 그 다음부터 쓰게 한다
 */
function setDirection(text, carryOn = false) {
    const v = String(text || '').trim();
    const notes = [];
    if (carryOn) notes.push('The player sent no new message and wants the story to move on. Continue from exactly where the previous reply ended and write only what happens next. Never repeat, retell, summarize or rewrite any part of the previous reply.');
    if (v) notes.push(`Story direction from the player for this reply only: ${v}\nThis is about what happens NEXT, after the previous reply's last moment. Do not rewrite earlier events to fit it. Work it into the new scene naturally.`);
    directionArmed = notes.length > 0;
    directionUsed = false;
    setExtensionPrompt(DIRECTION_KEY, notes.length ? `[${notes.join('\n')}\nDo not mention this note.]` : '',
        extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

/**
 * 실리태번이 지금 보내기를 받지 않는 이유. 실리태번은 이때 보내기 단추를 눌러도 아무 말 없이 무시한다
 * (스와이프가 덜 끝났거나, 이전 생성이 아직 잠겨 있거나, 슬래시 명령 실행 중)
 */
function sendBlockReason() {
    const sw = getContext().swipe?.state?.();
    if (sw === 'editing') return '스와이프 편집 중이라 보낼 수 없어요. 편집을 끝내 주세요';
    if (sw && sw !== 'none') return '이전 스와이프(다시 쓰기)가 끝나지 않은 상태라 보낼 수 없어요';
    if (stSendBusy()) return '실리태번이 이전 답장을 아직 처리 중이라 보낼 수 없어요';
    if (isExecutingCommandsFromChatInput) return '슬래시 명령이 실행 중이라 보낼 수 없어요';
    return '';
}

/** 보내지 못했을 때: 실리태번 입력칸에 남기지 않고 VN 입력칸으로 돌려준다 */
function sendRefused(why, text) {
    console.warn('[PickPlay] 보내기 막힘', { why, swipe: getContext().swipe?.state?.(), busy: stSendBusy(), generatingFlag: document.body.dataset.generating });
    toastr.warning(`${why}. 잠시 뒤 다시 보내 주세요. 계속 막히면 새로고침해 주세요.`, '픽플레이', { timeOut: 7000 });
    if (text && engine?.el?.free) engine.el.free.value = text;
}

/** @param {string} text 내 말 (빈칸이면 AI가 이어서 쓴다) @param {string} [direction] 다음 전개 */
function sendText(text, direction = '') {
    const ta = document.getElementById('send_textarea');
    if (!ta) return;
    const why = sendBlockReason();
    if (why) { sendRefused(why, text); return; }
    // 답장 받기가 실패해 내 말만 남아 있는데 같은 말을 다시 보내면, 새로 쌓지 않고 남아 있는 내 말로 답장만 다시 받는다
    // (빈칸으로 보내면 실리태번이 마지막 내 말에 이어 답장을 만든다)
    const chat = getContext().chat || [];
    const last = chat[chat.length - 1];
    if (last?.is_user && !isGenerating() && String(last.mes || '').trim() === String(text || '').trim()) text = '';
    // 마지막이 AI 답장인데 빈칸으로 보내면 "이어 쓰기": 직전 답장을 되풀이하지 않게 지시를 붙인다
    const carryOn = !String(text || '').trim() && !!last && !last.is_user;
    setDirection(direction, carryOn);
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send_but')?.click();
    // 그래도 실리태번이 받지 않았으면(입력칸에 글이 그대로, 생성도 안 시작) 입력칸을 비우고 VN으로 돌려준다
    const sent = String(text || '');
    if (sent.trim()) {
        setTimeout(() => {
            if (ta.value !== sent || isGenerating() || stSendBusy()) return;
            ta.value = '';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            sendRefused(sendBlockReason() || '실리태번이 보내기를 받지 않았어요', sent);
        }, 1500);
    }
}

/**
 * 마지막 턴인지. 턴 목록은 다시 만들 때마다 새 객체라서, 패널 등이 들고 있던 예전 턴과도 맞게 메시지 번호로 비교한다
 */
function isLatest(t) {
    const last = turns[turns.length - 1];
    return !!t && !!last && t.mesId === last.mesId;
}

function lastAiMessage() {
    const chat = getContext().chat || [];
    const m = chat[chat.length - 1];
    return m && !m.is_user && !m.is_system ? m : null;
}

async function swipe(dir) {
    const ctx = getContext();
    if (!lastAiMessage()) return;
    if (dir === 'left') await ctx.swipe.left(null, {});
    else await ctx.swipe.right(null, {});
}

async function reroll() {
    const ctx = getContext();
    const m = lastAiMessage();
    // 실리태번이 스와이프를 막는 경우엔 조용히 끝나므로 이유를 알려 준다
    if (!m) {
        const last = ctx.chat?.[ctx.chat.length - 1];
        toastr.info(last?.is_system ? '마지막 메시지가 숨김 상태라 다시 쓸 수 없어요. LOG에서 숨김을 풀어 주세요.' : '마지막 메시지가 AI 답장이 아니라서 다시 쓸 수 없어요.', '픽플레이');
        return;
    }
    if (ctx.swipe?.isAllowed && !ctx.swipe.isAllowed()) {
        toastr.info('지금은 다시 쓸 수 없어요. 생성이 끝났는지, 실리태번 설정에서 스와이프가 켜져 있는지 확인해 주세요.', '픽플레이');
        console.warn('[PickPlay] 다시 쓰기 막힘', { state: ctx.swipe.state?.(), generating: isGenerating() });
        return;
    }
    if (Array.isArray(m.swipes) && m.swipes.length) {
        await ctx.swipe.to(null, 'right', { forceSwipeId: m.swipes.length });
    } else {
        await ctx.swipe.right(null, {});
    }
}

/**
 * 마지막 턴(내 말 + 답장 + 그림 메시지)의 시작 위치. 첫 인사말은 지우지 않는다(null).
 * 내 말 없이 온 답장(QR의 /sendas 등)은 답장만 지운다 (userText가 빈 문자열)
 * @returns {{start: number, userText: string}|null}
 */
function undoRange() {
    const chat = getContext().chat || [];
    const last = turns[turns.length - 1];
    if (!last || last.mesId !== chat.length - 1 && (last.cgMesId ?? last.mesId) !== chat.length - 1) return null;
    const prev = turns[turns.length - 2];
    const start = prev ? Math.max(prev.mesId, prev.cgMesId ?? prev.mesId) + 1 : 0;
    const users = chat.slice(start).filter(m => m?.is_user);
    if (!users.length && start === 0) return null;
    return { start, userText: users.map(m => m.mes).join('\n') };
}

// ───────── 퀵 리플라이 (QR) ─────────

/** 실리태번 QR 바(또는 팝아웃)에 지금 보이는 버튼들 */
function quickReplyButtons() {
    return [...document.querySelectorAll('#qr--bar .qr--button, #qr--popout .qr--button')]
        .filter(b => !b.closest('.qr--hidden'));
}

function getQuickReplies() {
    // QR 세트마다 묶음 번호 (세트는 각자 .qr--buttons 칸에 그려진다. 여러 세트를 합쳐 보여도 안쪽 칸은 세트별)
    const sets = [];
    return quickReplyButtons().map((b) => {
        const label = b.querySelector('.qr--button-label:not(.qr--hidden)')?.textContent?.trim() || '';
        const iconEl = b.querySelector('.qr--button-icon:not(.qr--hidden)');
        const icon = iconEl ? [...iconEl.classList].find(c => c.startsWith('fa-') && c !== 'fa-solid') || '' : '';
        const set = b.closest('.qr--buttons');
        if (!sets.includes(set)) sets.push(set);
        return { label, icon, title: b.title || label, group: sets.indexOf(set) };
    }).filter(q => q.label || q.icon);
}

/** VN의 QR 버튼 → 실리태번의 같은 QR 버튼을 누른다 (QR 내용은 평소처럼 실행) */
function runQuickReply(index, q) {
    const list = quickReplyButtons().filter((b) => {
        const label = b.querySelector('.qr--button-label:not(.qr--hidden)')?.textContent?.trim() || '';
        return label || b.querySelector('.qr--button-icon:not(.qr--hidden)');
    });
    let btn = list[index];
    const labelOf = (b) => b?.querySelector('.qr--button-label:not(.qr--hidden)')?.textContent?.trim() || '';
    // 목록이 그사이 바뀌었으면 이름으로 다시 찾는다
    if (q?.label && labelOf(btn) !== q.label) btn = list.find(b => labelOf(b) === q.label);
    if (!btn) { toastr.info('그 QR 버튼을 찾지 못했어요.', '픽플레이'); return; }
    // QR은 조용한 생성(quiet)으로 답장을 만드는 경우가 많다. 잠깐 동안은 그것도 "작성 중"으로 보여 준다
    qrUntil = Date.now() + 8000;
    btn.click();
}
let qrUntil = 0;

/** 공략 정보 만들기 버튼의 마법봉 아이콘 */
const WAND_ICON = '<span class="pp-ico" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/></svg></span>';

/** 확인 창 (실리태번 팝업). 줄바꿈은 그대로 보인다 */
async function askConfirm(text, okLabel = '확인') {
    const ctx = getContext();
    const html = $('<div style="white-space:pre-line"></div>').text(text)[0].outerHTML;
    return !!(await ctx.callGenericPopup(html, ctx.POPUP_TYPE.CONFIRM, null, { okButton: okLabel, cancelButton: '취소' }));
}

/** 이 턴 되돌리기: 내 말과 답장을 지우고 내 말을 입력칸에 돌려놓는다 */
async function undoTurn() {
    if (isGenerating()) return;
    const range = undoRange();
    if (!range) { engine?.flash('지울 수 있는 턴이 없어요'); return; }
    const ctx = getContext();
    const ask = range.userText
        ? ['이 턴의 내 메세지와 답변을 지울까요?', '지우기']
        : ['이 답변을 지울까요?', '지우기'];
    const ok = await ctx.callGenericPopup(ask[0], ctx.POPUP_TYPE.CONFIRM, null, { okButton: ask[1], cancelButton: '취소' });
    if (!ok) return;
    while ((ctx.chat?.length || 0) > range.start) await ctx.deleteLastMessage();
    await ctx.saveChat();
    rebuild();
    if (range.userText) engine?.restoreDraft(range.userText);
}

async function editStatus({ kind, key, name, value }) {
    const t = turns[turns.length - 1];
    if (!t) return;
    const ctx = getContext();
    const m = ctx.chat[t.mesId];
    if (!m) return;
    m.extra = m.extra || {};
    const ov = m.extra.pp_user = m.extra.pp_user || { text: {}, gauge: {} };
    if (kind === 'text') ov.text[key] = value;
    else if (kind === 'mind') ((ov.mind ??= {})[key] ??= {})[name] = value;
    else (ov.gauge[key] = ov.gauge[key] || {})[name] = value;
    await ctx.saveChat();
    scheduleRebuild('keep');
}

/** 그림 단위 즐겨찾기. 그림이 붙은 메시지(새 메시지 모드면 이미지 메시지)에 저장한다 */
async function toggleFav(t, url, on) {
    const ctx = getContext();
    const m = ctx.chat[t.cgMesId ?? t.mesId];
    if (!m || !url) return;
    m.extra = m.extra || {};
    const set = new Set(Array.isArray(m.extra.pp_fav_images) ? m.extra.pp_fav_images : []);
    if (on) set.add(url); else set.delete(url);
    m.extra.pp_fav_images = [...set];
    await ctx.saveChat();
}

/** 그림 주소 비교용: AutoPic처럼 경로만 풀어서 (/user/images/…) */
function imageKeyOf(u) {
    try { return decodeURIComponent(new URL(u, location.origin).pathname); } catch { return String(u || ''); }
}

/** 채팅 전체(모든 메시지 · 모든 스와이프)에서 이 그림들의 기록만 지운다. 본문·갤러리에 실제로 쓰인 곳은 건드리지 않는다 */
function forgetImagesEverywhere(chat, urls) {
    const keys = new Set(urls.map(imageKeyOf));
    const isIt = (u) => !!u && keys.has(imageKeyOf(u));
    for (const m of chat || []) {
        const pairs = [[m.extra, m.mes], ...(m.swipe_info || []).map((info, i) => [info?.extra, m.swipes?.[i]])];
        for (const [ex, text] of pairs) {
            if (!ex) continue;
            for (const k of Object.keys(ex.autopic_images || {})) if (isIt(k)) delete ex.autopic_images[k];
            for (const list of Object.values(ex.pp_cg_history || {})) for (let j = list.length - 1; j >= 0; j--) if (isIt(list[j])) list.splice(j, 1);
            for (const k of Object.keys(ex.pp_scene_pick || {})) if (isIt(ex.pp_scene_pick[k])) delete ex.pp_scene_pick[k];
            if (Array.isArray(ex.pp_fav_images)) ex.pp_fav_images = ex.pp_fav_images.filter(u => !isIt(u));
            // 본문에서 자리가 빠진 슬롯의 기록 (다른 스와이프 본문에 자리가 있으면 그 스와이프 것은 남는다)
            const slots = ex.autopic_image_slots || {};
            for (const [sid, s] of Object.entries(slots)) if (isIt(s?.src) && !String(text || '').includes(sid)) delete slots[sid];
        }
    }
}

/**
 * CG 뷰어의 삭제(한 장·여러 장): 한 번만 묻고, 원하면 그림 파일까지 지운다.
 * 파일은 채팅 어디에도 더 이상 쓰이지 않을 때만 지운다 (다른 스와이프·메시지가 같은 그림을 쓰면 남김)
 */
async function deleteCgs(t, urls) {
    const ctx = getContext();
    urls = [...new Set(urls)].filter(Boolean);
    if (!urls.length) return false;
    let withFile = true;
    const html = `<div>${urls.length > 1 ? `그림 ${urls.length}장을` : '이 그림을'} 지울까요?</div>
        <label style="display:flex;gap:6px;align-items:center;justify-content:center;margin-top:10px">
        <input type="checkbox" id="pp_del_file" class="pp-switch pp-sm" checked> 원본 파일도 지우기 (되돌릴 수 없어요)</label>`;
    $(document).on('change.ppDel', '#pp_del_file', function () { withFile = this.checked; });
    const ok = await ctx.callGenericPopup(html, ctx.POPUP_TYPE.CONFIRM, null, { okButton: '지우기', cancelButton: '취소' });
    $(document).off('change.ppDel');
    if (!ok) return false;
    let done = 0;
    for (const url of urls) if (await deleteCg(t, url, { ask: false, save: false })) done++;
    // 지운 그림의 기록(AutoPic 태그 기록 · 버전 기록 · 즐겨찾기 · 빈 슬롯)도 채팅 전체에서 지운다.
    // 남아 있으면 아래 "아직 쓰이는 그림" 검사에 걸려 파일이 안 지워졌다
    forgetImagesEverywhere(ctx.chat, urls);
    await ctx.saveChat();
    if (withFile) {
        const used = JSON.stringify(ctx.chat);
        for (const url of urls) {
            const path = decodeURIComponent(String(url).split('?')[0]).replace(/^\/+/, '');
            if (!path.startsWith('user/images/') || used.includes(url) || used.includes(path)) continue;
            try {
                await fetch('/api/images/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ path }) });
            } catch (err) { console.warn('[PickPlay] 그림 파일 삭제 실패', path, err); }
        }
    }
    scheduleRebuild('keep');
    return done > 0;
}

/**
 * LOG: 마지막 턴에서 다른 답변을 보다가 그 줄을 누르면 그 답변으로 바꾼다 (실리태번 스와이프 그대로).
 * 지난 턴은 바꾸지 않고, 보던 답변으로 분기만 한다 (branchFrom)
 */
async function pickSwipe(t, idx) {
    const chat = getContext().chat || [];
    const m = chat[t.mesId];
    if (!m || t.mesId !== chat.length - 1 || !Number.isInteger(idx) || idx === (m.swipe_id ?? 0)) return false;
    await stSwipe(null, idx > (m.swipe_id ?? 0) ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: t.mesId, forceSwipeId: idx });
    return true;
}

/** LOG: 그 턴 답장의 다른 스와이프 첫 문장(번역본이 있으면 번역본)과 그 답변의 첫 그림 */
function swipePreview(t, idx) {
    const m = getContext().chat?.[t.mesId];
    const raw = m?.swipes?.[idx];
    if (raw == null) return null;
    const extra = m.swipe_info?.[idx]?.extra || {};
    const shown = extra.display_text || raw;
    const first = splitLines(shown).find(l => !l.extra);
    if (first?.n) first.n = speakerName(first.n);
    // 그림: 글 속 그림 자리(슬롯) → 글 속 <img> → 그 답변의 갤러리 순으로
    const slot = String(raw).match(/data-autopic-slot=["']([a-zA-Z0-9-]+)["']/)?.[1];
    const media = Array.isArray(extra.media) ? extra.media : [];
    const cg = (slot && extra.autopic_image_slots?.[slot]?.src)
        || String(raw).match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
        || media[Number.isInteger(extra.media_index) ? extra.media_index : media.length - 1]?.url
        || '';
    return { text: first ? (first.n ? first.n + ' — ' : '') + first.t : '', cg };
}


/** LOG → CG 보기: 다른 스와이프(답변)의 그림 목록. 지금 답변과 같은 방식으로 장면·리롤 버전을 모은다 */
function swipeCgs(t, idx) {
    const m = getContext().chat?.[t.mesId];
    if (m?.swipes?.[idx] == null) return null;
    const pm = { mes: m.swipes[idx], extra: m.swipe_info?.[idx]?.extra || {}, swipe_id: idx, swipe_info: m.swipe_info };
    const cgs = findCgs(pm);
    const scenes = mediaScenes(pm, cgs);
    if (scenes) Object.assign(cgs, { list: scenes.list, index: scenes.list.length - 1, source: 'scenes', versions: scenes.versions, keys: scenes.keys });
    const inline = inlineVersions(pm, cgs);
    if (inline) Object.assign(cgs, { list: inline.shown, versions: inline.versions, keys: inline.keys });
    const cgSeq = (cgs.source === 'slot' || cgs.source === 'img' || cgs.source === 'scenes') && cgs.list.length > 1;
    return { cg: cgs.list[cgs.index] || '', cgs: cgs.list, cgIndex: cgs.index, cgSource: cgs.source, cgSeq, cgVersions: cgs.versions || null, cgSceneKeys: cgs.keys || null };
}

/** LOG: 스와이프 하나 지우기 (마지막 하나는 못 지운다) */
async function removeSwipe(t, idx) {
    const ctx = getContext();
    const m = ctx.chat?.[t.mesId];
    if (!m?.swipes || m.swipes.length <= 1) return false;
    const ok = await ctx.callGenericPopup(`TURN의 ${idx + 1}번째 답변(스와이프)을 지울까요?`, ctx.POPUP_TYPE.CONFIRM, null, { okButton: '지우기', cancelButton: '취소' });
    if (!ok) return false;
    await deleteSwipe(idx, t.mesId);
    scheduleRebuild('keep');
    return true;
}

/** 대표 그림 바꾸기 (현재 메시지에 삽입 모드의 갤러리 선택과 같다) */
async function pickCg(t, index, versionUrl = '') {
    const ctx = getContext();
    const id = t.cgMesId ?? t.mesId;
    const m = ctx.chat[id];
    // 장면별 버전이 있는 턴(갤러리 장면·글 속 그림): 그 장면의 대표 버전을 고른다 (VN에서 보여 줄 그림만 바뀐다)
    if (m && versionUrl && t.cgSceneKeys?.[index]) {
        m.extra.pp_scene_pick = { ...(m.extra.pp_scene_pick || {}), [t.cgSceneKeys[index]]: versionUrl };
        await ctx.saveChat();
        scheduleRebuild('keep');
        return true;
    }
    if (!m || t.cgSource !== 'media' || !Array.isArray(m.extra?.media)) return false;
    const url = t.cgs[index];
    const mi = m.extra.media.findIndex(x => x?.url === url);
    if (mi < 0) return false;
    m.extra.media_index = mi;
    try { ctx.updateMessageBlock(id, m); } catch { /* 채팅창 표시만 늦게 바뀐다 */ }
    await ctx.saveChat();
    scheduleRebuild('keep');
    return true;
}

/** CG 뷰어에서 그림 하나 지우기 (메시지 갤러리에 붙은 그림만). 그림 파일은 지우지 않고 메시지에서만 뺀다 */
async function deleteCg(t, url, { ask = true, save = true } = {}) {
    const ctx = getContext();
    const id = t.cgMesId ?? t.mesId;
    const m = ctx.chat[id];
    if (!m) return false;
    // 본문·갤러리에는 없고 AutoPic 기록에만 남은 옛 버전: 기록에서만 지운다
    const confirmDrop = async (msg) => !ask || !!(await ctx.callGenericPopup(msg, ctx.POPUP_TYPE.CONFIRM, null, { okButton: '빼기', cancelButton: '취소' }));
    // 버전 기록(AutoPic 기록 · 대표 고르기 · VN 버전 기록)에서 이 그림을 뺀다
    const forget = () => {
        for (const k of Object.keys(m.extra?.autopic_images || {})) if (imageKeyOf(k) === imageKeyOf(url)) delete m.extra.autopic_images[k];
        if (m.extra?.pp_scene_pick) for (const k of Object.keys(m.extra.pp_scene_pick)) if (m.extra.pp_scene_pick[k] === url) delete m.extra.pp_scene_pick[k];
        for (const list of Object.values(m.extra?.pp_cg_history || {})) { const j = list.indexOf(url); if (j >= 0) list.splice(j, 1); }
    };
    const done = async (redraw) => {
        if (redraw) try { ctx.updateMessageBlock(id, m); } catch { /* 채팅창 표시만 늦게 바뀐다 */ }
        if (save) {
            await ctx.saveChat();
            scheduleRebuild('keep');
        }
        return true;
    };
    const inText = String(m.mes || '').includes(url) || Object.values(m.extra?.autopic_image_slots || {}).some(s => s?.src === url);
    const media = m.extra?.media;
    const mi = Array.isArray(media) ? media.findIndex(x => x?.url === url) : -1;
    // 같은 장면의 다른 버전들 (VN 버전 기록에서 이 그림과 같은 목록에 있는 것)
    const siblings = [...new Set(Object.values(m.extra?.pp_cg_history || {}).filter(l => l.includes(url)).flat())].filter(u => u !== url);
    const recorded = Object.keys(m.extra?.autopic_images || {}).some(k => imageKeyOf(k) === imageKeyOf(url)) || siblings.length > 0;
    // 본문·갤러리에는 없고 기록에만 남은 옛 버전: 기록에서만 지운다
    if (!inText && mi < 0 && recorded) {
        if (!await confirmDrop('이 버전을 목록에서 뺄까요? (그림 파일은 남아요)')) return false;
        forget();
        return done(false);
    }
    // 글 속 그림(태그 치환): 본문에서 그 그림 자리만 지운다. 번역본·스와이프 본문에서도 같이
    if (t.cgSource === 'slot' || t.cgSource === 'img') {
        const slots = m.extra?.autopic_image_slots || {};
        const slotId = Object.keys(slots).find(k => slots[k]?.src === url);
        const re = slotId
            ? new RegExp(`<(\\w+)[^>]*data-autopic-slot=["']${slotId}["'][^>]*>[\\s\\S]*?<\\/\\1>`, 'g')
            : new RegExp(`<img\\b[^>]*\\bsrc=["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'g');
        if (!re.test(m.mes || '')) return false;
        // 다시 그린 버전이 남아 있으면 그림 자리는 두고 남은 버전 중 가장 나중 것으로 바꾼다 (한 장 삭제가 장면 전체를 지우지 않게)
        if (slotId && siblings.length) {
            if (!await confirmDrop('이 버전을 지울까요? (그림 파일은 남아요)')) return false;
            const next = siblings[siblings.length - 1];
            slots[slotId] = { ...slots[slotId], src: next };
            const own = m.swipe_info?.[m.swipe_id ?? 0]?.extra?.autopic_image_slots?.[slotId];
            if (own) own.src = next;
            forget();
            return done(true);
        }
        if (!await confirmDrop('이 그림을 본문에서 뺄까요? (그림 파일은 남아요)')) return false;
        const strip = (s) => String(s || '').replace(re, '');
        m.mes = strip(m.mes);
        if (Array.isArray(m.swipes)) m.swipes[m.swipe_id ?? 0] = m.mes;
        if (typeof m.extra?.display_text === 'string') m.extra.display_text = strip(m.extra.display_text);
        if (slotId) delete slots[slotId];
        return done(true);
    }
    if (!Array.isArray(media)) return false;
    // 갤러리에서 이미 빠지고 AutoPic 기록에만 남은 옛 버전: 기록에서만 지운다
    if (mi < 0 && recorded) {
        if (!await confirmDrop('이 버전을 목록에서 뺄까요? (그림 파일은 남아요)')) return false;
        forget();
        return done(false);
    }
    if (mi < 0) return false;
    if (!await confirmDrop('이 그림을 이 메시지에서 뺄까요? (그림 파일은 남아요)')) return false;
    const cur = media[Number.isInteger(m.extra.media_index) ? m.extra.media_index : media.length - 1]?.url;
    media.splice(mi, 1);
    const ni = media.findIndex(x => x?.url === cur);
    m.extra.media_index = ni >= 0 ? ni : Math.max(0, media.length - 1);
    forget();
    return done(true);
}

/** LOG의 여기까지 삭제: 그 턴(내 말 포함)부터 마지막까지 지운다. 확인 한 번 */
async function deleteFromTurn(t) {
    if (isGenerating()) { engine?.flash('답장을 쓰는 중에는 지울 수 없어요'); return; }
    const i = turns.findIndex(x => x.mesId === t?.mesId);
    if (i <= 0) return;
    const prev = turns[i - 1];
    const start = Math.max(prev.mesId, prev.cgMesId ?? prev.mesId) + 1;
    const ctx = getContext();
    if (!await askConfirm(`TURN ${i + 1}부터 마지막까지 삭제할까요?\n내 메세지와 답변이 모두 지워져요.`, '삭제')) return;
    while ((ctx.chat?.length || 0) > start) await ctx.deleteLastMessage();
    await ctx.saveChat();
    rebuild();
}

/** LOG의 숨기기: 그 턴의 메시지(내 말·답장·그림 메시지)를 통째로 숨기거나 다시 보이게 한다 */
async function toggleTurnHidden(t, hide) {
    const i = turns.findIndex(x => x.mesId === t?.mesId);
    if (i < 0) return;
    const prev = turns[i - 1];
    const start = prev ? Math.max(prev.mesId, prev.cgMesId ?? prev.mesId) + 1 : 0;
    const end = Math.max(t.mesId, t.cgMesId ?? t.mesId);
    await hideChatMessageRange(start, end, !hide);
    await getContext().saveChat();
    scheduleRebuild('keep');
}

/**
 * LOG에서 고른 턴의 AI 메시지까지를 복사해 새 채팅(분기)으로 이동한다. 실리태번의 "분기 만들기"와 같다.
 * LOG에서 다른 답변(스와이프)을 보는 중이면 그 답변으로 분기한다
 */
async function branchFrom(t, swipeIdx = null) {
    const id = t?.cgMesId != null && t.cgMesId > t.mesId ? t.cgMesId : t?.mesId;
    if (id == null) return;
    // 그림이 다음 메시지에 따로 있는 턴은 마지막 메시지가 답장이 아니라서 스와이프를 고를 수 없다
    const swipeId = id === t.mesId && Number.isInteger(swipeIdx) && swipeIdx !== t.swipeId ? swipeIdx : null;
    try {
        const name = await branchChat(id, { swipeId });
        if (name) toastr.success('분기를 만들었어요', '픽플레이');
    } catch (err) {
        console.error('[PickPlay] 분기 실패', err);
        toastr.error('분기를 만들지 못했어요', '픽플레이');
    }
}

/**
 * JS-Slash-Runner 같은 확장은 본문의 ```html 코드 블록을 화면(iframe)으로 바꾸는데, 새로고침 직후처럼
 * 채팅을 연 시점에 따라 안 바꾸고 코드로 남겨 둘 때가 있다. 그러면 정규식 읽기·전문에 화면이 안 나왔다
 * → 아직 코드로 남은 HTML 블록이 있으면 "메시지가 그려졌다" 알림을 한 번 보내 다시 그리게 하고 잠깐 기다린다
 */
async function ensureFrontendRendered(id) {
    const mt = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
    const raw = () => [...(mt?.querySelectorAll('pre') || [])]
        .filter(p => !p.closest('.TH-render') && /<!doctype|<html|<body|<script/i.test(p.textContent || ''));
    if (!raw().length) return;
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, id, 'normal');
    await waitFor(() => !raw().length, 3000);
}

/**
 * 채팅창에는 최근 메시지만 그려진다(실리태번 "불러올 메시지 수" 설정).
 * 오래된 메시지면 그 메시지까지 불러와서 AutoPic이 리롤 버튼을 붙이게 한다.
 */
async function ensureMessageRendered(id) {
    const sel = `#chat .mes[mesid="${id}"]`;
    if (document.querySelector(sel)) return document.querySelector(sel);
    const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
    if (Number.isNaN(first) || id >= first) return null;
    await showMoreMessages(first - id);
    if (!document.querySelector(sel)) return null;
    // (예전엔 없는 이벤트 이름 MESSAGE_RENDERED를 보내서 아무 일도 안 일어났다)
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, id, 'normal');
    // AutoPic은 다음 화면 갱신 때 버튼을 붙인다
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector(sel);
}

/**
 * AutoPic이 다시 그린 그림을 바꿔 끼워도 실리태번 알림을 보내지 않는 경우가 있다.
 * 그 메시지의 그림 상태를 잠시 지켜보다가 바뀌면 VN을 다시 그린다 (CG 뷰어의 버전 점이 바로 늘어나게)
 */
let cgWatch = null;
function watchCgChange(id) {
    const sig = () => {
        const m = getContext().chat?.[id];
        if (!m) return '';
        return [m.mes, (m.extra?.media || []).map(x => x?.url).join(','), Object.keys(m.extra?.autopic_images || {}).join(','),
            Object.values(m.extra?.autopic_image_slots || {}).map(s => s?.src).join(',')].join('|');
    };
    clearInterval(cgWatch?.timer);
    const start = sig();
    const until = Date.now() + 5 * 60 * 1000;
    cgWatch = { timer: setInterval(() => {
        if (sig() !== start) {
            clearInterval(cgWatch.timer);
            cgWatch = null;
            scheduleRebuild('keep');
            // 다시 그린 그림이 버전 기록에 붙은 뒤 한 번 저장한다
            setTimeout(() => { if (historyDirty) { historyDirty = false; getContext().saveChat?.(); } }, 1500);
        }
        else if (Date.now() > until) { clearInterval(cgWatch.timer); cgWatch = null; }
    }, 1500) };
}

/**
 * AutoPic의 그림 다시 그리기를 부른다. 고르는 순서:
 * 1) 생성이 시작되지 못해 비어 있는 그림 자리 → 그것부터 채운다
 * 2) 지금 VN에 보이는 그림의 다시 그리기 버튼 (그 그림의 태그로 다시 그린다. 메시지 전체 버튼은 마지막 그림의 프롬프트를 쓴다)
 * 3) 마지막 턴인데 그림이 여러 장이거나 아직 그림으로 안 바뀐 <autopic> 태그가 남았으면 → 요술봉 (장면별로 골라 다시 그린다)
 * 4) 그 메시지의 아무 다시 그리기 버튼, 그림이 없으면 수동 생성 버튼
 * 5) 마지막 턴이면 요술봉
 */
async function rerollCg(t, url = '') {
    const id = t?.cgMesId ?? t?.mesId;
    if (id != null) watchCgChange(id);
    const mes = id != null ? await ensureMessageRendered(id) : null;
    if (id != null && emptySlots(getContext().chat?.[id]).length) { void fillEmptySlots(id); return; }
    const isLastTurn = turns.length && isLatest(t);
    const wand = document.getElementById('st_image_reroll_wand_button');
    // 요술봉은 스와이프를 새로 만든 뒤에도 이전 스와이프 갤러리 그림을 잡아 이전 태그를 띄우므로, 보이는 그림의 버튼이 먼저다
    const file = String(url).split('/').pop();
    const own = file ? [...(mes?.querySelectorAll('.reroll-trigger[data-image-src]') || [])]
        .find(b => decodeURIComponent(b.getAttribute('data-image-src') || '').endsWith(decodeURIComponent(file))) : null;
    if (own) { own.click(); return; }
    // 명령어·QR로 만든 메시지는 태그가 그대로 남기도 한다 (수동 생성 버튼은 태그를 무시하고 새로 한 장만 만든다)
    const leftTags = /<autopic\b/i.test(getContext().chat?.[id]?.mes || '');
    if (isLastTurn && wand && (t?.cgSeq || leftTags)) { wand.click(); return; }
    const btn = mes?.querySelector('.reroll-trigger, .autopic-image-reroll-button')
        || (t?.cg ? null : mes?.querySelector('.autopic-manual-generate-btn'));
    if (btn) { btn.click(); return; }
    if (isLastTurn && wand) { wand.click(); return; }
    toastr.info('이 턴의 그림을 다시 생성할 수 없어요. AutoPic 설정에서 수동 생성을 켜 보세요.', '픽플레이');
}

/**
 * QR의 /sendas는 메시지를 화면에 그리기 전에 MESSAGE_RECEIVED를 보낸다. 번역 호환(슬롯) 모드의 AutoPic은
 * 그때 화면 갱신에서 오류가 나서 그림 자리만 잡고 생성을 시작하지 못한다.
 * 그런 메시지는 VN이 AutoPic의 슬롯 다시 그리기를 하나씩 눌러 채운다 (NovelAI는 동시 생성을 막는다)
 */
const slotFillIds = new Set();
let slotFilling = false;
function emptySlots(m) {
    const slots = m?.extra?.autopic_image_slots || {};
    const ids = [...String(m?.mes || '').matchAll(/data-autopic-slot=["']([a-zA-Z0-9-]+)["']/g)].map(x => x[1]);
    return [...new Set(ids)].filter(sid => slots[sid] && !slots[sid].src && slots[sid].editText);
}
function waitFor(test, ms, step = 250) {
    return new Promise(resolve => {
        const until = Date.now() + ms;
        const tick = () => {
            const v = test();
            if (v || Date.now() > until) resolve(v || null);
            else setTimeout(tick, step);
        };
        tick();
    });
}
async function fillEmptySlots(id) {
    if (slotFilling) return;
    slotFilling = true;
    try {
        const chat = getContext().chat;
        const m = chat?.[id];
        for (const sid of emptySlots(m)) {
            if (getContext().chat !== chat || chat[id] !== m || !engine) return;
            const holder = (await ensureMessageRendered(id))?.querySelector(`span[data-autopic-slot="${sid}"]`);
            if (!holder) return;
            // AutoPic은 슬롯 안의 .reroll-trigger 클릭을 그 슬롯 다시 그리기로 받는다
            const trigger = document.createElement('span');
            trigger.className = 'reroll-trigger';
            trigger.hidden = true;
            holder.append(trigger);
            trigger.click();
            trigger.remove();
            // 프롬프트 확인 창은 그대로 생성으로 넘긴다
            const ok = await waitFor(() => document.querySelector('dialog.popup[open] .reroll_popup_container')
                ?.closest('dialog.popup')?.querySelector('.popup-button-ok'), 3000);
            if (!ok) return;
            ok.click();
            if (!await waitFor(() => m.extra?.autopic_image_slots?.[sid]?.src, 200000, 1000)) return;
            scheduleRebuild('keep');
        }
    } finally { slotFilling = false; }
}

// ───────── 번역 확장 연동 (번역본을 extra.display_text에 넣는 번역 확장 공통) ─────────
// 특정 확장 이름에 기대지 않는다: 메시지 버튼 줄의 번역 버튼, 확장 설정의 자동 번역 값, 번역 중 표시를 넓게 찾는다

/** 원문으로 보기로 고른 턴 "mesId:swipeId" (이번 접속 동안만) */
const forceOriginal = new Set();
/** 자동 번역을 기다리는 마지막 턴 { key, since, sawBusy } */
let transPending = null;
/** 번역 도착 전에 원문으로 넘긴 턴. 번역이 오면 알려 준다 */
let lateWatch = null;
let transTimer = null;
/** 번역이 시작조차 안 되면(번역 대상이 아님 등) 이만큼 기다린 뒤 원문으로. 번역 자체에는 시간 제한 없음 */
const TRANS_START_GRACE = 6000;

const transKey = (t) => `${t.mesId}:${t.swipeId}`;

function hasTranslation(m) {
    const d = m?.extra?.display_text;
    return typeof d === 'string' && !!d.trim() && d !== m.mes;
}

/** 메시지 버튼 줄에서 번역 버튼: 클래스나 제목에 translat / 번역이 들어간 버튼 (중지·삭제·편집 버튼은 빼고) */
const TRANSLATE_BTN = ['.mes_buttons', '.extraMesButtons']
    .flatMap(p => [`${p} [class*="translat" i]`, `${p} [title*="translat" i]`, `${p} [title*="번역"]`]).join(', ');
const NOT_TRANSLATE = /stop|cancel|delete|remove|edit|toggle|original|중지|중단|삭제|수정|원문/i;

function translateButton(root) {
    const all = [...(root?.querySelectorAll(TRANSLATE_BTN) || [])].filter(b => !NOT_TRANSLATE.test(`${b.className} ${b.title || ''}`));
    // 번역 단추를 여러 개 붙이는 확장도 있다(예전 방식·새 방식). 사용자가 숨겨 둔 단추는 건너뛴다
    // (메시지 단추 줄 자체가 접혀 있어도 단추 자기 표시 값은 그대로라 이것만 본다)
    return all.find(b => !b.hidden && b.style.display !== 'none' && getComputedStyle(b).display !== 'none') || all[0] || null;
}

/** 번역 확장이 켜져 있는지 (채팅창 메시지에 번역 버튼이 붙어 있으면 켜진 것) */
function translatorPresent() {
    return !!translateButton(document.getElementById('chat'));
}

/**
 * 답장이 오면 자동으로 번역하는 설정인지. 이름에 translat이 들어간 확장 설정에서
 * auto로 시작하는 값이 켜져 있는지 본다 (true, 또는 all·ai·responses·both 같은 값)
 */
function autoTranslateOn() {
    if (!translatorPresent()) return false;
    return Object.entries(extension_settings).some(([name, s]) => /translat/i.test(name) && s && typeof s === 'object'
        && Object.entries(s).some(([k, v]) => /^auto/i.test(k) && (v === true || /^(all|ai|responses|both|on|always)$/i.test(String(v)))));
}

/** 그 메시지를 지금 번역하는 중인지: aria-busy, 번역 버튼의 translating·busy 표시, 돌아가는 아이콘 */
function translatingNow(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!el) return false;
    if (el.getAttribute('aria-busy') === 'true') return true;
    const btn = translateButton(el);
    return !!btn && (/translating|busy|loading/i.test(btn.className) || !!btn.querySelector('.fa-spin') || btn.classList.contains('fa-spin'));
}

/**
 * 원문과 번역을 함께 보여주는 설정(원문 박스, 줄마다 원문 병기)이면 번역본에 원문 줄이 섞여 있다.
 * 원문 줄의 절반 이상이 번역본에 그대로 있으면 섞인 것으로 보고, 원문 줄을 한 번씩 뺀다.
 */
function dropOriginalLines(shown, orig) {
    const key = (l) => `${l.n}|${l.t}`;
    const pool = new Map();
    // "TEXT로 보기" 줄은 원문·번역 양쪽에 똑같이 있어도 남긴다
    for (const l of orig) if (l.t.length >= 4 && !l.extra) pool.set(key(l), (pool.get(key(l)) || 0) + 1);
    let total = 0;
    for (const c of pool.values()) total += c;
    if (!total) return shown;
    const found = shown.filter(l => pool.has(key(l))).length;
    if (found < total * 0.5) return shown;
    return shown.filter((l) => {
        const c = pool.get(key(l));
        if (!c) return true;
        pool.set(key(l), c - 1);
        return false;
    });
}

/** 마지막 턴이 번역을 기다리는 중인지 정해 엔진에 알린다 */
function updateTranslating() {
    if (!engine) return;
    const t = turns[turns.length - 1];
    const key = t ? transKey(t) : '';
    if (lateWatch) {
        const lt = turns.find(x => transKey(x) === lateWatch);
        if (lt?.trans.has) {
            lateWatch = null;
            engine.flash('번역이 도착했어요 · TRANS를 누르면 번역으로 봐요');
        }
    }
    let wait = false;
    // 답장이 이미 한국어면 번역을 기다리지 않는다. 자동 번역을 켜 둔 채 한국어로 플레이하면
    // 번역 확장이 한국어 답장을 그냥 넘기거나 오래 붙잡고 있어서 "번역 중"이 계속 떠 있었다
    const korean = t && !isForeign(t.lines.filter(l => !l.extra).map(l => l.t).join(' '));
    if (t?.trans.has) {
        if (transPending?.key === key) transPending = null;
    } else if (korean) {
        if (transPending?.key === key) transPending = null;
        // 기다리지 않고 원문으로 시작했으니, 나중에 번역 확장이 한국어→한국어 번역본을 넣어도 읽는 도중에 글이 바뀌지 않게
        // 원문에 고정한다 (보고 싶으면 TRANS로 번역본 전환)
        forceOriginal.add(key);
    } else if (t && !forceOriginal.has(key)) {
        if (translatingNow(t.mesId)) {
            wait = true;
            if (transPending?.key === key) transPending.sawBusy = true;
        } else if (transPending?.key === key) {
            // 번역이 끝났는데 번역본이 없으면(실패·중단) 원문으로 보여준다
            if (transPending.sawBusy || Date.now() - transPending.since > TRANS_START_GRACE) transPending = null;
            else wait = true;
        }
    }
    engine.setTranslating(wait);
    clearTimeout(transTimer);
    if (wait) transTimer = setTimeout(pollTranslation, 700);
}

function pollTranslation() {
    const t = turns[turns.length - 1];
    const m = t && getContext().chat?.[t.mesId];
    if (m && hasTranslation(m)) scheduleRebuild('keep');
    else updateTranslating();
}

/** 번역을 기다리지 않고 원문으로 */
function showOriginalNow(t) {
    const key = transKey(t);
    forceOriginal.add(key);
    if (!t.trans.has) lateWatch = key;
    if (transPending?.key === key) transPending = null;
    engine?.setTranslating(false);
    scheduleRebuild('keep');
}

/** TRANS: 번역본이 있으면 원문/번역 전환, 없으면 번역 확장에 번역을 요청한다 */
async function toggleTranslation(t) {
    const key = transKey(t);
    if (t.trans.has) {
        if (forceOriginal.has(key)) forceOriginal.delete(key);
        else forceOriginal.add(key);
        engine?.flash(forceOriginal.has(key) ? '원문으로 보여요' : '번역으로 보여요');
        scheduleRebuild('keep');
        return;
    }
    if (translatingNow(t.mesId)) { engine?.flash('번역 중이에요'); return; }
    const mes = await ensureMessageRendered(t.mesId);
    const btn = translateButton(mes);
    if (!btn) { toastr.info('번역 확장의 번역 버튼을 찾지 못했어요.', '픽플레이'); return; }
    forceOriginal.delete(key);
    if (lateWatch === key) lateWatch = null;
    if (isLatest(t)) transPending = { key, since: Date.now(), sawBusy: false };
    btn.click();
    engine?.flash('번역을 요청했어요');
    setTimeout(updateTranslating, 300);
}

// ───────── 켜기 / 끄기 ─────────

function mount() {
    if (engine) return;
    host = document.getElementById('pp-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pp-host' }));
    engine = new PPEngine(host, {
        items: activeItems(),
        typingMs: settings().typingMs,
        autoMs: settings().autoMs,
        dialogueStyle: settings().dialogueStyle,
        screenFx: () => !!settings().screenFx,
        soundAvailable,
        soundOn: () => soundAvailable() && !settings().soundMuted,
        choicesOn: () => settings().choices !== false,
        onToggleSound: () => {
            settings().soundMuted = !settings().soundMuted;
            saveSettingsDebounced();
            applySound();
        },
        onBgm: (name) => sound.setBgm(name),
        hasExtraUi,
        extraUiNode,
        resumePage,
        onPosition: savePosition,
        menuOuter: settings().menuOuter,
        playSfx: (name) => sound.playSfx(name),
        fontSize: settings().fontSize,
        windowAlpha: settings().windowAlpha,
        accent: settings().accent,
        onSend: sendText,
        onSwipe: swipe,
        // 상태창 크기 (테마마다). 예전 높이만 저장하던 값도 읽는다
        statusSize: (style) => settings().statusSizes?.[style] || { h: 0, w: 0 },
        onStatusSize: (style, size) => {
            (settings().statusSizes ??= {})[style] = size;
            saveSettingsDebounced();
        },
        // ⋯ → 테마: 설정 화면의 테마 칸과 같다
        onTheme: (v) => {
            settings().dialogueStyle = ['box', 'retro', 'sub', 'cinema'].includes(v) ? v : 'box';
            saveSettingsDebounced();
            engine?.setDialogueStyle(settings().dialogueStyle);
            $('#pp_dialogue_style').val(settings().dialogueStyle);
        },
        onReroll: reroll,
        // 실리태번의 생성 중지와 같다
        onStop: () => {
            const ctx = getContext();
            if (typeof ctx.stopGeneration === 'function') ctx.stopGeneration();
            else document.getElementById('mes_stop')?.click();
        },
        onEdit: editStatus,
        onUndo: undoTurn,
        getQuickReplies,
        onChatSettings: () => openStatusPicker(),
        onReady: onAnswerReady,
        onQuickReply: runQuickReply,
        canUndo: () => !!undoRange(),
        onFav: toggleFav,
        onPickCg: pickCg,
        onDeleteCgs: deleteCgs,
        swipePreview,
        onPickSwipe: pickSwipe,
        swipeCgs,
        onRemoveSwipe: removeSwipe,
        onRerollCg: rerollCg,
        onBranch: branchFrom,
        confirm: askConfirm,
        onToggleHidden: toggleTurnHidden,
        onDeleteFrom: deleteFromTurn,
        ensureRendered: (t) => (t ? ensureMessageRendered(t.mesId).then(() => ensureFrontendRendered(t.mesId)).catch(() => null) : null),
        onTranslate: toggleTranslation,
        onShowOriginal: showOriginalNow,
        canTranslate: translatorPresent,
        startValue,
        metOnly: () => !!castMembers(),
        // 단계 칸 막대: { n: 단계 수, i: 지금 단계, frac: 지금 단계 안에서 찬 정도 }
        tierMeter: (v) => {
            const t = AFFINITY.tiers;
            const i = Math.max(0, t.indexOf(tierOf(v)));
            const next = t[i + 1]?.min ?? 101;
            return { n: t.length, i, frac: Math.min(1, Math.max(0, (v - t[i].min) / (next - t[i].min))) };
        },
        onExit: () => setEnabled(false),
        getRegistered: () => registered,
        formatGauge,
        showNumbers: () => settings().affinityDisplay === 'number',
    });
    lastKey = '';
    syncActive();
    applySound();
    rebuild();
    engine.setGenerating(isGenerating());
    watchChatDom();
    maybeAskStatus();
}

// ───────── 이 채팅의 상태창 (처음 켤 때 묻기) ─────────

/** 처음 켤 때, 또는 호감도·속마음을 쓰는데 아직 캐릭터 명단이 없는 채팅(예전 채팅)이면 고르기 창을 띄운다 */
function maybeAskStatus() {
    if (!engine || !hasCharacter()) return;
    if (statusChoice() && !(usesCast() && !castMembers())) return;
    // 새 채팅은 항상 "상태창 쓰기 / 쓰지 않기"부터 묻는다 (공략 후보가 없어도)
    openStatusPicker();
}

/**
 * 상태창을 쓸지, 어떤 항목을 쓸지 고르는 창 (캐릭터 명단 · 공략 정보도 여기서). 처음 켤 때 한 번, 이후에는 ⋯ → STATUS
 */
function openStatusPicker() {
    if (!engine) { toastr.info('픽플레이를 켠 채팅에서 고를 수 있어요.', '픽플레이'); return; }
    if (!hasCharacter()) { toastr.info('캐릭터 채팅을 먼저 열어 주세요.', '픽플레이'); return; }
    const prev = statusChoice();
    const checked = new Set(prev ? activeItemIds(prev) : settings().items.filter(it => !it.fixed || it.enabled).map(it => it.id));
    let on = prev ? !!prev.on : true;

    const panel = $(`
        <div class="pp-frame pp-solid pp-panel pp-pop pp-panel-pick">
            <div class="pp-panel-head">
                <div class="pp-panel-title"><span class="pp-panel-tag">STATUS</span><span class="pp-panel-name">이 채팅 상태창</span></div>
                <button type="button" class="pp-btn pp-pick-close" title="${prev ? '바꾸지 않고 닫기' : '지금은 고르지 않고 닫기 (다음에 켤 때 다시 물어봐요)'}">닫기</button>
            </div>
            <div class="pp-pick-modes">
                <button type="button" class="pp-pick-mode-btn" data-on="1">상태창 쓰기</button>
                <button type="button" class="pp-pick-mode-btn" data-on="0">쓰지 않기</button>
            </div>
            <div class="pp-pick-items">
                <section class="pp-pick-sec">
                    <div class="pp-pick-title">커스텀 상태창</div>
                    <div class="pp-pick-list pp-pick-custom"></div>
                    <div class="pp-pick-add pp-item-add">
                        <input type="text" class="pp-pick-input" placeholder="새 항목 이름 (예: 소지금, 체력)" maxlength="20">
                        <select class="pp-pick-type"><option value="text">텍스트</option><option value="gauge">게이지</option></select>
                        <button type="button" class="pp-btn pp-pick-addbtn">추가</button>
                    </div>
                </section>
                <section class="pp-pick-sec">
                    <div class="pp-pick-title">시스템 상태창</div>
                    <div class="pp-pick-list pp-pick-sys"></div>
                <div class="pp-pick-sub pp-pick-rel">
                    <div class="pp-pick-subtitle">캐릭터 명단</div>
                    <div class="pp-pick-rel-list"></div>
                    <div class="pp-pick-add pp-cast-add">
                        <input type="text" class="pp-pick-input pp-cast-input" placeholder="이름 추가" maxlength="30" aria-label="명단에 넣을 이름">
                        <button type="button" class="pp-btn pp-pick-addbtn pp-cast-addbtn">추가</button>
                    </div>
                </div>
                <div class="pp-pick-sub pp-pick-traits">
                    <div class="pp-tr-head">
                        <span class="pp-tr-text">
                            <span class="pp-pick-subtitle">공략 정보</span>
                            <span class="pp-hint">캐릭터별 호감도 상승·하락 속도와 판정 메모</span>
                        </span>
                        <span class="pp-tr-btns">
                            <button type="button" class="pp-btn pp-tr-reveal"></button>
                            <button type="button" class="pp-btn pp-tr-make"></button>
                        </span>
                    </div>
                    <div class="pp-tr-maker" hidden></div>
                    <div class="pp-tr-list" hidden></div>
                </div>
                </section>
            </div>
            <div class="pp-panel-foot">
                <span class="pp-pick-actions">
                    <button type="button" class="pp-btn-accent pp-pick-done">${prev ? '저장' : '시작하기'}</button>
                </span>
            </div>
        </div>`);

    // 캐릭터 명단: 시스템 상태창(호감도·속마음 등)이 함께 쓴다. 다른 표기(번역 안 된 이름 등)도 공통.
    // 호감도를 켜면 캐릭터마다 체크(호감도를 쌓을지) · 시작 관계도 고른다
    const cands = castCandidates();
    const removedNow = [];
    // 예전에 × 로 지웠다가 직접 다시 넣은 이름
    const restoredNow = [];
    const affOn = () => settings().items.some(it => it.fixed === 'aff' && checked.has(it.id));
    const renderRel = () => {
        const aff = affOn();
        const box = panel.find('.pp-pick-rel');
        box.toggle(settings().items.some(it => it.fixed && checked.has(it.id)));
        box.toggleClass('pp-rel-noaff', !aff);
        const list = box.find('.pp-pick-rel-list').empty();
        if (!cands.length) list.append($('<span class="pp-hint pp-cast-empty">아직 없어요. 아래에서 이름을 추가해 주세요</span>'));
        // 칸 제목: 스위치 = 호감도를 쌓을지, 이름 = 화면(이름표·상태창)에 보일 이름, 맨 오른쪽 = 번역 전 원문 이름
        else list.append($(`<div class="pp-cast-row pp-cast-cols" aria-hidden="true">
            <span class="pp-hint pp-cast-col-aff">호감도</span><span class="pp-hint">이름</span><span class="pp-hint pp-cast-col-start">시작 관계</span><span class="pp-hint pp-cast-col-alias">번역 전 이름</span></div>`));
        renderTraits();
        for (const c of cands) {
            const row = $('<div class="pp-cast-row"></div>');
            const sw = $('<input type="checkbox" class="pp-switch pp-sm pp-cast-aff">').attr('aria-label', `${c.name} 호감도 쌓기`).prop('checked', c.on)
                .on('change', function () { c.on = this.checked; renderRel(); });
            const name = $('<span class="pp-cast-name"><input type="text" class="pp-cast-rename" maxlength="30"></span>');
            // 이름은 눌러서 고친다 (로어북 제목이 "제1과 / 이름"처럼 길 때 등). 비우거나 다른 사람과 겹치면 되돌린다
            name.find('.pp-cast-rename').val(c.name).attr('aria-label', '이름').on('change', function () {
                const v = String(this.value).trim();
                if (!v || cands.some(o => o !== c && normName(o.name) === normName(v))) { this.value = c.name; return; }
                c.name = v;
                renderRel();
            });
            const start = $('<select class="pp-pick-rel-sel"></select>').attr('aria-label', `${c.name} 시작 관계`);
            start.append($('<option value="unmet">아직 안 만남</option>'));
            AFFINITY.tiers.forEach((t, i) => start.append($('<option></option>').val(i).text(t.label)));
            start.val(String(c.start)).prop('disabled', !c.on)
                .on('change', function () { c.start = this.value === 'unmet' ? 'unmet' : Number(this.value); });
            // 번역 전 이름: 대사 이름표가 이 이름이면 위의 이름으로 보이고, 호감도·속마음도 이 사람에게 모인다 (한국어 채팅이면 비워 둔다)
            const alias = $('<input type="text" class="pp-pick-input pp-cast-alias" placeholder="번역 전 이름 (없으면 비워 두기)">')
                .attr('aria-label', `${c.name} 번역 전 이름`).val(c.aliases.join(', '))
                .on('change', function () { c.aliases = String(this.value).split(/[,，、]/).map(x => x.trim()).filter(Boolean); });
            // 이름 옆 × : 이 채팅 명단에서 지운다 (저장해야 반영)
            const del = $('<button type="button" class="pp-cast-del" title="명단에서 지우기" aria-label="명단에서 지우기">×</button>');
            del.on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                cands.splice(cands.indexOf(c), 1);
                removedNow.push(c.orig || c.name);
                renderRel();
            });
            name.append(del);
            list.append(row.append(...(aff ? [sw] : []), name, start, alias));
        }
    };
    // 명단에 직접 넣기 (로어북·예전 판정에서 못 찾은 사람). 이미 있으면 체크만 켠다
    const addCast = () => {
        const input = panel.find('.pp-cast-input');
        const name = String(input.val() || '').trim();
        if (!name) return;
        const same = cands.find(c => [c.name, ...c.aliases, ...c.former].some(x => normName(x) === normName(name)));
        if (same) same.on = true;
        else cands.push({ name, on: true, start: 'unmet', aliases: [], former: [] });
        const r = removedNow.findIndex(n => normName(n) === normName(name));
        if (r >= 0) removedNow.splice(r, 1);
        restoredNow.push(name);
        input.val('');
        renderRel();
    };

    // 공략 정보(캐릭터 기질): 호감도를 켰을 때만. 내용은 [열어 보기]를 눌러야 보인다
    let revealed = false;
    let makerOpen = false;
    // 자료 고르기가 열려 있으면 명단 체크가 바뀔 때 대상·합계를 다시 계산한다
    let refreshMaker = null;
    const castTargets = () => cands.filter(c => c.on).map(c => c.name);
    // 기질은 로어북 이름으로 만들어졌을 수 있어서 다른 표기로도 찾는다
    // 공략 정보의 저장 이름 찾기: 분석할 때의 이름(로어북 이름 등)으로 저장돼 있을 수 있어서 번역 전 이름·예전 이름으로도 찾는다
    const traitKey = (name, tr) => Object.keys(tr).find(k => normName(k) === normName(name)
        || cands.some(o => o.name === name && [...o.aliases, ...o.former, o.orig || ''].some(a => normName(a) === normName(k))));
    // 속도를 분석한 사람 (메모만 적은 사람은 아직 분석 전)
    const hasTrait = (name, tr) => typeof tr[traitKey(name, tr)]?.gain === 'number';
    const allHaveTraits = () => castTargets().length > 0 && castTargets().every(n => hasTrait(n, traits() || {}));
    const renderTraits = () => {
        const box = panel.find('.pp-pick-traits');
        const show = on && affOn();
        box.toggle(show);
        if (!show) return;
        const people = castTargets();
        box.find('.pp-tr-reveal').text(revealed ? '가리기' : '열어 보기').prop('hidden', !people.length);
        box.find('.pp-tr-make').html(WAND_ICON + (allHaveTraits() ? '다시 분석' : '속도 분석')).prop('hidden', makerOpen);
        refreshMaker?.();
        const list = box.find('.pp-tr-list').prop('hidden', !revealed || !people.length).empty();
        if (revealed) list.append(traitRows(people));
    };
    // 명단에서 호감도를 쌓는 사람마다 한 줄. 누르면 속도와 판정 메모를 고친다 (이 채팅에만 저장)
    const traitRows = (people) => people.map((person) => {
        const tr = traits() || {};
        const key = traitKey(person, tr) || person;
        const t = tr[key] || {};
        const row = $(`<details class="pp-tr-row">
            <summary><b class="pp-tr-name"></b><span class="pp-tr-mult"></span></summary>
            <div class="pp-tr-edit">
                <label>상승 속도 <input type="number" class="pp-tr-gain" min="0.5" max="1.5" step="0.1"></label>
                <label>하락 속도 <input type="number" class="pp-tr-loss" min="0.5" max="1.5" step="0.1"></label>
                <label class="pp-tr-wide">판정 메모 <textarea class="pp-tr-memo" rows="3" placeholder="예: 차갑게 대할수록 오히려 더 끌려 한다 / 칭찬받으면 툴툴대지만 속으로는 좋아한다"></textarea></label>
            </div>
        </details>`);
        const summary = (v) => (typeof v.gain === 'number' ? `상승 ${v.gain} · 하락 ${v.loss}` : '속도 분석 전') + (String(v.memo || '').trim() ? ' · 메모' : '');
        row.find('.pp-tr-name').text(person);
        row.find('.pp-tr-mult').text(summary(t));
        const edit = (patch) => {
            const next = structuredClone(traits() || {});
            next[key] = Object.assign({}, next[key], patch);
            saveTraits(next);
            row.find('.pp-tr-mult').text(summary(next[key]));
        };
        row.find('.pp-tr-gain').val(t.gain ?? 1).on('change', function () { this.value = clampMult(this.value); edit({ gain: Number(this.value), loss: t.loss ?? clampMult(row.find('.pp-tr-loss').val()) }); });
        row.find('.pp-tr-loss').val(t.loss ?? 1).on('change', function () { this.value = clampMult(this.value); edit({ loss: Number(this.value), gain: t.gain ?? clampMult(row.find('.pp-tr-gain').val()) }); });
        row.find('.pp-tr-memo').val(t.memo || '').on('change', function () { edit({ memo: String(this.value).trim() }); });
        return row;
    });
    // 기질 만들기: 대상(명단에서 호감도 체크한 사람 중 기질이 없는 사람)과 읽을 자료를 고르고 토큰 수를 보여 준다
    const openMaker = async () => {
        makerOpen = true;
        renderTraits();
        const box = panel.find('.pp-tr-maker').prop('hidden', false).empty()
            .append($('<span class="pp-hint">로어북을 읽는 중…</span>'));
        const entries = await loreEntries();
        if (!makerOpen || !panel[0].isConnected) return;
        const card = cardFields();
        const cardText = traitsCardText(card);
        const allNames = () => cands.filter(c => c.on).flatMap(c => [c.name, ...c.aliases]);
        // 명단 인물 이름과 맞는 항목만 미리 체크 (유저가 풀거나 더 고를 수 있다)
        const picked = new Set(entries.filter(e => loreMatchesName(e, allNames())).map(e => e.id));
        // 봇카드 디스크립션은 로어북에 인물 항목이 없을 때만 미리 체크 (1인봇은 카드가 곧 캐릭터 설명, 다인봇 카드는 대개 세계·규칙 설명이라)
        let useCard = !!cardText && !picked.size;
        // 체크한 사람이 모두 기질을 가지고 있으면 "다시 만들기"로 열린다 (모두 새로 만들기가 켜진 채로)
        let replaceAll = allHaveTraits();
        const tokens = new Map();
        const count = async (key, text) => {
            if (tokens.has(key)) return tokens.get(key);
            let n;
            try { n = await getContext().getTokenCountAsync(text); } catch { n = Math.ceil(text.length / 2); }
            tokens.set(key, n);
            return n;
        };
        const targets = () => {
            const tr = traits() || {};
            return castTargets().filter(n => replaceAll || !hasTrait(n, tr));
        };
        const hasAny = () => castTargets().some(n => hasTrait(n, traits() || {}));
        const row = (label, tokKey, text, isOn, onChange) => {
            const el = $('<label class="pp-tr-src"><input type="checkbox" class="pp-switch pp-sm"><span class="pp-tr-src-name"></span><span class="pp-tr-src-tok">…</span></label>');
            el.find('.pp-tr-src-name').text(label);
            el.find('input').prop('checked', isOn).on('change', function () { onChange(this.checked); updateFoot(); });
            count(tokKey, text).then(n => el.find('.pp-tr-src-tok').text(`약 ${n.toLocaleString()}`));
            return el;
        };
        const foot = $('<div class="pp-tr-foot"><span class="pp-hint pp-tr-total"></span><span class="pp-tr-actions"><button type="button" class="pp-btn pp-tr-cancel">취소</button><button type="button" class="pp-btn-accent pp-tr-go">만들기</button></span></div>');
        const target = $('<div class="pp-hint pp-tr-target"></div>');
        const updateFoot = async () => {
            const names = targets();
            target.text(names.length ? `대상: ${names.join(', ')}` : hasAny() ? '체크한 사람은 모두 속도를 분석했어요' : '명단에서 호감도를 쌓을 사람을 체크해 주세요');
            const parts = [useCard ? count('card', cardText) : 0, ...entries.filter(e => picked.has(e.id)).map(e => count(e.id, traitsLoreText(e)))];
            const total = (await Promise.all(parts)).reduce((a, b) => a + b, 0);
            foot.find('.pp-tr-total').text(`합계 약 ${total.toLocaleString()}토큰 · 지금 연결된 API로 1번 요청해요`);
            foot.find('.pp-tr-go').prop('disabled', !names.length || (!useCard && !picked.size) || traitsBusy);
        };
        const srcList = $('<div class="pp-tr-srcs"></div>');
        if (cardText) srcList.append(row('봇카드 디스크립션', 'card', cardText, useCard, (v) => { useCard = v; }));
        for (const e of entries) srcList.append(row(e.title, e.id, traitsLoreText(e), picked.has(e.id), (v) => { if (v) picked.add(e.id); else picked.delete(e.id); }));
        if (!cardText && !entries.length) srcList.append($('<span class="pp-hint">읽을 자료가 없어요</span>'));
        const redo = $('<label class="pp-tr-redo"><input type="checkbox" class="pp-switch pp-sm"><span>분석한 사람도 다시 분석</span></label>');
        redo.find('input').prop('checked', replaceAll).on('change', function () { replaceAll = this.checked; updateFoot(); });
        const closeMaker = () => { makerOpen = false; refreshMaker = null; box.prop('hidden', true).empty(); renderTraits(); };
        foot.find('.pp-tr-cancel').on('click', closeMaker);
        foot.find('.pp-tr-go').on('click', async function () {
            const names = targets();
            $(this).prop('disabled', true).text('만드는 중…');
            const ok = await generateTraits({ names, entries: entries.filter(e => picked.has(e.id)), useCard });
            if (!panel[0].isConnected) return;
            if (ok) closeMaker();
            else $(this).text('만들기').prop('disabled', false);
        });
        box.empty().append(target, $('<div class="pp-hint">읽을 자료</div>'), srcList, redo, foot);
        refreshMaker = () => { redo.toggle(hasAny()); updateFoot(); };
        refreshMaker();
    };
    // 이 채팅에서만 쓰는 항목 (저장 전까지 이 창 안에서만 바뀐다)
    const extra = chatItems(prev).map(it => ({ ...it }));
    // 커스텀 항목 순서 (이 채팅에만). 저장된 순서 → 없는 항목은 기본 순서대로 뒤에
    let order = Array.isArray(prev?.order) ? [...prev.order] : [];
    const customItems = () => [...settings().items.filter(x => !x.fixed), ...extra];
    const syncOrder = () => {
        const all = customItems().map(it => it.id);
        order = [...order.filter(id => all.includes(id)), ...all.filter(id => !order.includes(id))];
    };
    const moveBtns = (it) => {
        const mk = (text, title, d) => $(`<button type="button" class="pp-pick-del pp-pick-move" title="${title}" aria-label="${title}">${text}</button>`)
            .on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const i = order.indexOf(it.id), j = i + d;
                if (i < 0 || j < 0 || j >= order.length) return;
                [order[i], order[j]] = [order[j], order[i]];
                renderList();
            });
        return [mk('‹', '앞으로', -1), mk('›', '뒤로', 1)];
    };
    const renderList = () => {
        const sys = panel.find('.pp-pick-sys').empty();
        const custom = panel.find('.pp-pick-custom').empty();
        const toggle = (it, label) => {
            const row = $('<label class="pp-pick-item"><input type="checkbox" class="pp-switch pp-sm"><span class="pp-pick-label"></span></label>');
            row.find('.pp-pick-label').text(label);
            row.find('input').prop('checked', checked.has(it.id)).on('change', function () {
                if (this.checked) checked.add(it.id); else checked.delete(it.id);
                renderRel();
            });
            return row;
        };
        // 시스템 상태창: 늘 보이고 켜고 끄기만. 여기서 켜고 끄는 건 이 채팅에만 (확장 설정 스위치는 새 채팅의 기본값)
        for (const [key, label] of [['aff', '호감도'], ['mind', '카오모지 + 속마음']]) {
            const it = settings().items.find(x => x.fixed === key);
            if (!it) continue;
            const row = toggle(it, label);
            sys.append(row);
        }
        // 커스텀 상태창: 확장 설정의 항목(지우면 설정에서도 빠짐) + 이 채팅에서만 쓰는 항목. ‹ ›로 이 채팅의 순서를 바꾼다
        syncOrder();
        const byOrder = customItems().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        for (const it of byOrder.filter(x => !extra.includes(x))) {
            const row = toggle(it, it.label);
            const del = $('<button type="button" class="pp-pick-del" title="이 항목 지우기" aria-label="지우기">×</button>');
            del.on('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!await askConfirm(`"${it.label}" 항목을 지울까요?\n확장 설정의 커스텀 상태창에서도 지워져서, 다른 채팅에서도 빠져요.`, '지우기')) return;
                const all = settings().items;
                const i = all.indexOf(it);
                if (i >= 0) all.splice(i, 1);
                checked.delete(it.id);
                saveSettingsDebounced();
                renderItems();
                renderList();
                renderRel();
                scheduleRebuild('keep');
            });
            row.data('ppId', it.id);
            custom.append(row.append(...moveBtns(it), del));
        }
        for (const it of extra) {
            const row = $('<span class="pp-pick-item pp-pick-own pp-on"><span class="pp-pick-label"></span><button type="button" class="pp-pick-del" title="이 항목 지우기" aria-label="지우기">×</button></span>');
            row.find('.pp-pick-label').text(it.label + (it.type === 'gauge' ? ' (게이지)' : ''));
            row.find('.pp-pick-del').on('click', () => { extra.splice(extra.indexOf(it), 1); renderList(); }).before(...moveBtns(it));
            row.data('ppId', it.id);
            custom.append(row);
        }
        // 설정 항목과 이 채팅 항목이 섞인 순서대로 다시 놓는다
        custom.append(custom.children().get().sort((a, b) => order.indexOf($(a).data('ppId')) - order.indexOf($(b).data('ppId'))));
    };
    const renderMode = () => {
        panel.find('.pp-pick-mode-btn').each(function () { $(this).toggleClass('pp-on', (this.dataset.on === '1') === on).attr('aria-pressed', String((this.dataset.on === '1') === on)); });
        panel.find('.pp-pick-items').toggle(on);
    };
    // 새 항목 줄 (명단의 이름 추가 줄과 구분: 목록 바로 밑의 줄)
    const itemAdd = panel.find('.pp-item-add');
    const addItem = () => {
        const input = itemAdd.find('.pp-pick-input');
        const label = String(input.val() || '').trim();
        if (!label) return;
        const type = itemAdd.find('.pp-pick-type').val() === 'gauge' ? 'gauge' : 'text';
        // 여기서 추가한 항목은 이 채팅에만 (기본 항목은 확장 설정에서)
        extra.push({ id: 'c' + Date.now(), label, type, perChar: false });
        input.val('');
        renderList();
    };
    const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !e.originalEvent.isComposing) { e.preventDefault(); fn(); } };

    panel.find('.pp-pick-mode-btn').on('click', function () { on = this.dataset.on === '1'; renderMode(); renderTraits(); });
    itemAdd.find('.pp-pick-addbtn').on('click', addItem);
    itemAdd.find('.pp-pick-input').on('keydown', onEnter(addItem));
    panel.find('.pp-cast-addbtn').on('click', addCast);
    panel.find('.pp-cast-input').on('keydown', onEnter(addCast));
    panel.find('.pp-tr-reveal').on('click', () => { revealed = !revealed; renderTraits(); });
    panel.find('.pp-tr-make').on('click', openMaker);
    // 닫기·Esc: 저장하지 않는다. 처음이면 그동안 전체 항목을 쓰고, 다음에 켤 때 다시 묻는다
    const close = () => { $(document).off('keydown.pppick'); engine?.setModal(null); };
    panel.find('.pp-pick-close').on('click', close);
    $(document).off('keydown.pppick').on('keydown.pppick', (e) => {
        if (!panel[0].isConnected) { $(document).off('keydown.pppick'); return; }
        if (e.key === 'Escape' && !$(e.target).is('input, select')) { e.preventDefault(); e.stopPropagation(); close(); }
    });
    panel.find('.pp-pick-done').on('click', async () => {
        const ids = settings().items.map(it => it.id).filter(id => checked.has(id));
        const useCast = on && settings().items.some(it => it.fixed && checked.has(it.id));
        if (useCast) getContext().chatMetadata.pp_cast = castFromCandidates(cands, removedNow, restoredNow);
        syncOrder();
        await saveStatusChoice({ on: on && (ids.length > 0 || extra.length > 0), ids, extra, order });
        close();
    });
    renderList();
    renderRel();
    renderMode();
    engine.setModal(panel[0]);
}

async function saveStatusChoice(choice) {
    const ctx = getContext();
    if (!ctx.chatMetadata) return;
    // seen: 고를 때 있던 항목. 그 뒤에 새로 켠 추천 항목은 이 채팅에도 기본으로 쓴다
    ctx.chatMetadata.pp_status = { ...choice, seen: settings().items.map(it => it.id) };
    await ctx.saveMetadata();
    scheduleRebuild('keep');
}

let chatObserver = null;
let chatObserverTimer = null;

/**
 * 번역 확장처럼 이벤트 없이 메시지 표시만 바꾸는 경우를 잡기 위해 채팅창 변화를 지켜본다.
 * (번역 확장 중에는 번역 후 display_text만 저장하고 다시 그리는 것도 있다)
 */
/**
 * 답장이 끝난 뒤 마지막 답장의 글(원문·번역본)이 알림 없이 바뀌는 경우가 있다
 * (생성 중으로 잡힌 사이에 끝난 화면 갱신, 알림을 안 보내는 번역 확장 등). 그러면 선택지·상태창이 빠진 채로 남고
 * 새로고침해야 나왔다 → 끝난 뒤 90초 동안 2초마다 글을 비교해서 바뀌면 다시 읽는다
 */
let textWatch = null;
function watchLatestText() {
    clearInterval(textWatch);
    const sig = () => {
        const chat = getContext().chat || [];
        return chat.slice(-2).map(m => [m?.swipe_id, m?.mes, m?.extra?.display_text].join('\u0001')).join('\u0002');
    };
    // 첫 확인(2초 뒤)은 무조건 한 번 다시 읽는다 (끝난 순간 읽은 글이 덜 된 것이었을 수 있어서)
    let last = '';
    const until = Date.now() + 90 * 1000;
    textWatch = setInterval(() => {
        if (!engine || Date.now() > until) { clearInterval(textWatch); textWatch = null; return; }
        if (isGenerating()) return;
        const now = sig();
        if (now !== last) { last = now; scheduleRebuild('keep'); }
    }, 2000);
}

function watchChatDom() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || chatObserver) return;
    chatObserver = new MutationObserver((records) => {
        // 생성 중(스트리밍)의 글자 변화는 무시한다. 끝나면 GENERATION_ENDED가 다시 읽는다
        if (isGenerating()) return;
        // 그림 칸 안의 변화(그림 생성 진행 표시 등)는 본문이 아니라서 다시 읽지 않는다
        const inImage = (n) => (n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement)?.closest?.(IMAGE_PARTS);
        // (그림 자체가 들어오거나 빠지면 CG가 바뀌니 다시 읽는다)
        const hasImg = (r) => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === Node.ELEMENT_NODE && (n.matches('img') || n.querySelector('img')));
        if (records.every(r => inImage(r.target) && !hasImg(r))) return;
        clearTimeout(chatObserverTimer);
        chatObserverTimer = setTimeout(() => scheduleRebuild('keep'), 300);
    });
    chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });
}

function unmount() {
    traitsToken++;
    traitsBusy = false;
    chatObserver?.disconnect();
    chatObserver = null;
    clearTimeout(chatObserverTimer);
    document.body.classList.remove('pp-active');
    engine?.destroy();
    engine = null;
    // VN을 끄면 음악도 멈춘다
    sound.stop();
    applySound();
}

function isGenerating() {
    return document.body.dataset.generating === 'true' || $('#mes_stop').is(':visible');
}

function setEnabled(on) {
    settings().enabled = !!on;
    saveSettingsDebounced();
    $('#pp_enabled').prop('checked', !!on);
    if (on) mount();
    else unmount();
    updatePrompt();
    renderWandLabel();
}

// ───────── 설정 메뉴 ─────────

function renderItems() {
    const box = $('#pp_items');
    if (!box.length) return;
    const all = settings().items;
    // 목록에는 기본·직접 추가 항목만 (추천 항목은 아래 켜기/끄기)
    const items = all.filter(it => !it.fixed);
    // 목록 안에서 자리 바꾸기: 전체 배열에서 두 항목의 자리를 맞바꾼다
    const swap = (x, y) => { const i = all.indexOf(x), j = all.indexOf(y); [all[i], all[j]] = [all[j], all[i]]; };
    box.empty();
    items.forEach((it, idx) => {
        const card = $('<div class="pp-item-card"></div>');
        const top = $('<div class="pp-item-top"></div>');
        const label = $('<input type="text" class="text_pole" aria-label="항목 이름">').val(it.label);
        // 종류: 텍스트(짧은 글) / 게이지(0~100 숫자). AI에게는 이름과 종류로 알려 준다
        const type = $('<select class="text_pole" aria-label="항목 종류"><option value="text">텍스트</option><option value="gauge">게이지</option></select>')
            .val(it.type === 'gauge' ? 'gauge' : 'text');
        top.append(label, type);
        const actions = $('<div class="pp-item-actions"></div>');
        const btn = (icon, title, fn, disabled) => $(`<div class="menu_button menu_button_icon" title="${title}"><i class="fa-solid ${icon}"></i></div>`)
            .toggleClass('disabled', !!disabled).on('click', () => { if (!disabled) fn(); });
        actions.append(
            btn('fa-chevron-up', '위로', () => { swap(it, items[idx - 1]); itemsChanged(true); }, idx === 0),
            btn('fa-chevron-down', '아래로', () => { swap(it, items[idx + 1]); itemsChanged(true); }, idx === items.length - 1),
            btn('fa-trash-can', '삭제', () => { all.splice(all.indexOf(it), 1); itemsChanged(true); }),
        );
        label.on('change', function () { it.label = this.value.trim() || '항목'; itemsChanged(); });
        type.on('change', function () {
            it.type = this.value === 'gauge' ? 'gauge' : 'text';
            it.perChar = false;
            itemsChanged(true);
        });
        card.append(top, actions);
        box.append(card);
    });
    // 추천 항목 켜기/끄기
    const rec = (id) => all.find(it => it.fixed === id);
    $('#pp_rec_aff').prop('checked', !!rec('aff')?.enabled);
    $('#pp_rec_mind').prop('checked', !!rec('mind')?.enabled);
    // 호감도를 켰을 때만 호감도 설정을 보여 준다
    $('#pp_aff_sec').toggle(!!rec('aff')?.enabled);
}

/** 설정: 호감도 단계 목록 (점수 이상이면 그 단계) */
function renderTiers() {
    const box = $('#pp_tiers');
    if (!box.length) return;
    const tiers = settings().tiers;
    box.empty();
    tiers.forEach((t, idx) => {
        const row = $(`<div class="pp-tier-row">
            <input type="number" class="text_pole pp-tier-min" min="0" max="100" aria-label="시작 점수">
            <span class="pp-tier-unit">점부터</span>
            <input type="text" class="text_pole pp-tier-label" maxlength="12" aria-label="단계 이름">
            <div class="menu_button menu_button_icon pp-tier-del" title="삭제"><i class="fa-solid fa-trash-can"></i></div>
        </div>`);
        row.find('.pp-tier-min').val(idx === 0 ? 0 : t.min).prop('disabled', idx === 0)
            .on('change', function () { t.min = Number(this.value) || 0; tiersChanged(true); });
        row.find('.pp-tier-label').val(t.label).on('change', function () { t.label = this.value.trim() || '단계'; tiersChanged(); });
        row.find('.pp-tier-del').toggleClass('disabled', tiers.length <= 1)
            .on('click', () => { if (tiers.length > 1) { tiers.splice(idx, 1); tiersChanged(true); } });
        box.append(row);
    });
}

function tiersChanged(redraw = false) {
    const s = settings();
    applyTiers();
    s.tiers = AFFINITY.tiers.map(({ label, min }) => ({ label, min }));
    saveSettingsDebounced();
    if (redraw) renderTiers();
    engine?.renderStatus();
    scheduleRebuild('keep');
}

function itemsChanged(redraw = false) {
    saveSettingsDebounced();
    if (redraw) renderItems();
    scheduleRebuild('keep');
}

async function initSettingsUi() {
    const html = await $.get(`${FOLDER}settings.html`);
    $('#extensions_settings2').append(html);
    $('#pp_enabled').prop('checked', settings().enabled).on('change', function () { setEnabled(this.checked); });
    // 시스템 상태창(호감도·속마음) 켜기/끄기. 새 채팅 기본값이면서, 지금 채팅에도 바로 켜고 끈다
    for (const id of ['aff', 'mind']) {
        $('#pp_rec_' + id).on('change', function () {
            const it = settings().items.find(x => x.fixed === id);
            if (!it) return;
            it.enabled = this.checked;
            const c = statusChoice();
            if (c?.on && this.checked !== c.ids.includes(it.id)) {
                c.ids = this.checked ? [...c.ids, it.id] : c.ids.filter(x => x !== it.id);
                getContext().saveMetadata();
            }
            itemsChanged(true);
        });
    }
    $('#pp_add_item').on('click', () => {
        const it = { id: 'c' + Date.now(), label: '새 항목', type: 'text', perChar: false };
        settings().items.push(it);
        // 설정에서 추가한 항목은 지금 채팅에도 바로 쓴다
        const c = statusChoice();
        if (c?.on) { c.ids = [...c.ids, it.id]; getContext().saveMetadata(); }
        itemsChanged(true);
    });

    renderTiers();
    $('#pp_add_tier').on('click', () => {
        const tiers = settings().tiers;
        const top = Math.max(...tiers.map(t => Number(t.min) || 0));
        tiers.push({ label: '새 단계', min: Math.min(100, top + 10) });
        tiersChanged(true);
    });
    $('#pp_reset_tiers').on('click', () => {
        settings().tiers = [{ label: '지인', min: 0 }, { label: '친구', min: 30 }, { label: '호감', min: 60 }, { label: '특별', min: 80 }];
        tiersChanged(true);
    });
    // 설정 탭: 마지막으로 연 탭을 기억한다 (브라우저마다)
    const showTab = (name) => {
        $('.pp-settings .pp-tab-btn').each(function () { $(this).toggleClass('pp-on', this.dataset.tab === name).attr('aria-selected', String(this.dataset.tab === name)); });
        $('.pp-settings .pp-sec').each(function () { $(this).toggle(this.dataset.tab === name); });
        try { localStorage.setItem('pp_settings_tab', name); } catch { /* 저장 못 해도 동작에는 문제 없음 */ }
    };
    $('.pp-settings .pp-tab-btn').on('click', function () { showTab(this.dataset.tab); });
    let lastTab = 'status';
    try { lastTab = localStorage.getItem('pp_settings_tab') || 'status'; } catch { /* 기본 탭 */ }
    showTab($(`.pp-settings .pp-tab-btn[data-tab="${lastTab}"]`).length ? lastTab : 'status');
    $('#pp_affinity_display').val(settings().affinityDisplay).on('change', function () {
        settings().affinityDisplay = this.value === 'number' ? 'number' : 'tier';
        saveSettingsDebounced();
        engine?.renderStatus();
    });
    $('#pp_dialogue_style').val(settings().dialogueStyle).on('change', function () {
        settings().dialogueStyle = ['box', 'retro', 'sub', 'cinema'].includes(this.value) ? this.value : 'box';
        saveSettingsDebounced();
        engine?.setDialogueStyle(settings().dialogueStyle);
    });
    $('#pp_reply_length').val(settings().replyLength).on('change', function () {
        settings().replyLength = REPLY_LENGTH[this.value] ? this.value : 'preset';
        saveSettingsDebounced();
        updatePrompt();
    });
    $('#pp_font_size').val(String(settings().fontSize)).on('change', function () {
        settings().fontSize = Math.max(16, Math.min(30, Number(this.value) || 21));
        saveSettingsDebounced();
        engine?.applyLook({ fontSize: settings().fontSize });
    });
    const showAlpha = () => $('#pp_window_alpha_val').text(`${Math.round(settings().windowAlpha * 100)}%`);
    $('#pp_window_alpha').val(Math.round(settings().windowAlpha * 100)).on('input', function () {
        settings().windowAlpha = Math.max(0.4, Math.min(1, Number(this.value) / 100 || 1));
        showAlpha();
        saveSettingsDebounced();
        engine?.applyLook({ windowAlpha: settings().windowAlpha });
    });
    showAlpha();
    // 메인 색: 견본을 누르거나 직접 고른다. 모든 테마의 강조색이 이 색 하나를 따른다
    const setAccent = (hex, save = true) => {
        if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
        settings().accent = hex.toLowerCase();
        $('#pp_accent').val(settings().accent);
        $('.pp-swatch').each(function () { $(this).toggleClass('pp-on', this.dataset.color === settings().accent); });
        // 확장 설정창(스위치·탭 등)도 같은 색으로
        document.documentElement.style.setProperty('--pp-user-accent', settings().accent);
        if (!save) return;
        saveSettingsDebounced();
        engine?.applyLook({ accent: settings().accent });
    };
    $('#pp_accent').on('input', function () { setAccent(this.value); });
    $('.pp-swatch').on('click', function () { setAccent(this.dataset.color); });
    setAccent(/^#[0-9a-f]{6}$/i.test(settings().accent) ? settings().accent : defaultSettings.accent, false);
    $('#pp_hidden_tags').val(settings().hiddenTags || '').on('change', function () {
        settings().hiddenTags = String(this.value || '');
        setHiddenTags(settings().hiddenTags.split(','));
        saveSettingsDebounced();
        scheduleRebuild('keep');
    });
    $('#pp_screen_fx').prop('checked', !!settings().screenFx).on('change', function () {
        settings().screenFx = this.checked;
        saveSettingsDebounced();
        updatePrompt();
        engine?.renderCg();
    });
    // BGM·효과음
    const syncSoundRows = () => $('#pp_sound_detail').prop('hidden', !settings().sound);
    $('#pp_sound').prop('checked', !!settings().sound).on('change', function () {
        settings().sound = this.checked;
        syncSoundRows();
        saveSettingsDebounced();
        applySound();
        engine?.renderMenu();
        updatePrompt();
        if (this.checked) loadSoundFiles();
    });
    syncSoundRows();
    for (const kind of ['bgm', 'sfx']) {
        const key = `${kind}Volume`;
        const show = () => $(`#pp_${kind}_volume_val`).text(`${settings()[key]}%`);
        $(`#pp_${kind}_volume`).val(settings()[key]).on('input', function () {
            settings()[key] = Math.max(0, Math.min(100, Number(this.value) || 0));
            show();
            saveSettingsDebounced();
            applySound();
        });
        show();
        $(`#pp_open_${kind}`).on('click', () => copyFolderPath(kind));
    }
    $('#pp_sound_refresh').on('click', () => loadSoundFiles());
    // 프롬프트 탭: 비어 있으면 기본 틀을 쓴다 (기본값과 같으면 저장하지 않아 나중 업데이트가 반영되게)
    $('#pp_prompt_template').val(String(settings().promptTemplate || '').trim() || DEFAULT_PROMPT_TEMPLATE).on('input', function () {
        const v = String(this.value || '');
        settings().promptTemplate = v.trim() === DEFAULT_PROMPT_TEMPLATE ? '' : v;
        saveSettingsDebounced();
        updatePrompt();
    });
    $('#pp_prompt_reset').on('click', () => {
        settings().promptTemplate = '';
        $('#pp_prompt_template').val(DEFAULT_PROMPT_TEMPLATE);
        saveSettingsDebounced();
        updatePrompt();
    });
    // 어떤 설정을 바꾸든 프롬프트 탭의 "보내는 내용"이 바로 따라오게 (각 칸의 처리가 끝난 뒤)
    $('.pp-settings').on('change', 'input, select', () => setTimeout(updatePrompt, 0));
    updatePrompt();
    // 바깥 메뉴 버튼: 늘 3개. 3개를 다 고르면 나머지는 잠그고, 덜 고르면 기본값(SKIP·LOG·CG)으로 채워 보여 준다
    const syncOuter = () => {
        const list = settings().menuOuter;
        $('.pp-pin').each(function () {
            this.checked = list.includes(this.value);
            this.disabled = !this.checked && list.length >= MENU_OUTER_COUNT;
        });
        $('#pp_menu_outer_hint').text(list.length < MENU_OUTER_COUNT ? `${MENU_OUTER_COUNT - list.length}개 더 골라 주세요 (그동안은 기본 버튼으로 채워요)` : '');
    };
    $('.pp-pin').on('change', function () {
        const set = new Set(settings().menuOuter);
        if (this.checked) set.add(this.value); else set.delete(this.value);
        settings().menuOuter = [...set].slice(0, MENU_OUTER_COUNT);
        syncOuter();
        saveSettingsDebounced();
        engine?.setMenuOuter(settings().menuOuter);
    });
    syncOuter();
    loadSoundFiles();
    $('#pp_choices').prop('checked', settings().choices !== false).on('change', function () {
        settings().choices = this.checked;
        saveSettingsDebounced();
        updatePrompt();
        engine?.renderChoices();
    });
    $('#pp_ready_sound').prop('checked', !!settings().readySound).on('change', function () {
        settings().readySound = this.checked;
        saveSettingsDebounced();
        if (this.checked) playReadySound();
    });
    // 타이핑 속도: 오른쪽으로 갈수록 빠르게 (막대 값 = 110 - 한 글자당 ms). AUTO 대기: 초 단위
    const typingWord = (ms) => (ms <= 25 ? '빠름' : ms <= 55 ? '보통' : '느림');
    const showTyping = () => $('#pp_typing_val').text(typingWord(settings().typingMs));
    const showAuto = () => $('#pp_auto_val').text(`${(settings().autoMs / 1000).toFixed(1).replace(/\.0$/, '')}초`);
    $('#pp_typing').val(110 - Math.max(10, Math.min(100, settings().typingMs)))
        .on('input', function () { settings().typingMs = 110 - Number(this.value); showTyping(); })
        .on('change', () => { saveSettingsDebounced(); engine?.setTiming({ typingMs: settings().typingMs }); });
    $('#pp_auto').val(Math.max(0.5, Math.min(5, settings().autoMs / 1000)))
        .on('input', function () { settings().autoMs = Math.round(Number(this.value) * 1000); showAuto(); })
        .on('change', () => { saveSettingsDebounced(); engine?.setTiming({ autoMs: settings().autoMs }); });
    showTyping();
    showAuto();
    renderItems();
}

/** 마법봉 메뉴 맨 위에 켜기/끄기. 처음 켜는 채팅이면 켠 뒤 모드 선택 화면이 뜬다 */
function addMenuButton() {
    const btn = $(`<div id="pp_wand" class="list-group-item flex-container flexGap5" title="픽플레이 켜기/끄기">
        <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span class="pp-wand-label"></span></div>`);
    btn.on('click', () => setEnabled(!settings().enabled));
    $('#extensionsMenu').prepend(btn);
    renderWandLabel();
}

function renderWandLabel() {
    $('#pp_wand .pp-wand-label').text(settings().enabled ? '픽플레이 끄기' : '픽플레이 켜기');
}

function registerCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp',
        callback: () => { setEnabled(!settings().enabled); return ''; },
        helpString: '픽플레이를 켜거나 끕니다.',
    }));
}

// ───────── 이벤트 ─────────

function bindEvents() {
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        traitsToken++;
        traitsBusy = false;
        engine?.setModal(null);
        forceOriginal.clear();
        transPending = null;
        lateWatch = null;
        scheduleRebuild('latest');
        // 명단 후보는 로어북 인물로 만들므로, 새 채팅의 로어북을 다 읽은 뒤에 묻는다 (먼저 물으면 이전 채팅 인물이 후보로 나온다)
        const chatId = getContext().chatId;
        await refreshNames();
        if (getContext().chatId === chatId) maybeAskStatus();
    });
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, dryRun) => {
        if (dryRun || (type === 'quiet' && Date.now() > qrUntil)) return;
        if (directionArmed) directionUsed = true;
        engine?.setGenerating(true);
    });
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, _params, dryRun) => {
        if (dryRun || !settings().enabled) return;
        if (type === 'quiet') {
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
            return;
        }
        turns = buildTurns();
        const chat = getContext().chat || [];
        updatePrompt(type === 'swipe' ? chat.length - 1 : -1);
    });
    // 생성이 끝나면 새 답변을 먼저 읽고 나서 대기 표시를 끈다.
    // 순서가 반대면 그 틈에 이전 턴의 선택지가 잠깐 보인다.
    const done = () => {
        // 다음 전개는 한 번 쓰면 지운다 (다시 쓰기·스와이프에는 붙지 않는다)
        if (directionUsed) setDirection('');
        pendingGenerationEnd = true;
        scheduleRebuild('keep');
        watchLatestText();
    };
    eventSource.on(event_types.GENERATION_ENDED, done);
    eventSource.on(event_types.GENERATION_STOPPED, done);
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => {
        // 자동 번역이 켜져 있으면 새 답변은 번역이 올 때까지 "번역 중"으로 기다린다
        const m = getContext().chat?.[Number(id)];
        // 아직 화면에 없는 메시지(/sendas 등)는 AutoPic 슬롯 생성이 막힌다. 그려진 뒤 VN이 채운다
        if (m && !m.is_user && !document.querySelector(`#chat .mes[mesid="${Number(id)}"]`)) slotFillIds.add(Number(id));
        if (m && !m.is_user && autoTranslateOn()) {
            transPending = { key: `${Number(id)}:${Number(m.swipe_id ?? 0)}`, since: Date.now(), sawBusy: false };
        }
        scheduleRebuild('keep');
    });
    eventSource.on(event_types.MESSAGE_SENT, () => scheduleRebuild('keep'));
    eventSource.on(event_types.MESSAGE_UPDATED, () => scheduleRebuild('keep'));
    eventSource.on(event_types.MESSAGE_EDITED, () => scheduleRebuild('keep'));
    eventSource.on(event_types.MESSAGE_DELETED, () => scheduleRebuild('keep'));
    eventSource.on(event_types.MESSAGE_SWIPED, () => scheduleRebuild('latest'));
    eventSource.on(event_types.MESSAGE_SWIPE_DELETED, () => scheduleRebuild('latest'));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        const n = Number(id);
        if (slotFillIds.delete(n) && engine && emptySlots(getContext().chat?.[n]).length) setTimeout(() => fillEmptySlots(n), 300);
        scheduleRebuild('keep');
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, stripOldPpBlocks);
    // 번역 완료 알림을 보내는 번역 확장도 있다
    eventSource.on('EXTENSION_LLM_TRANSLATE_DONE', () => scheduleRebuild('keep'));
    eventSource.on(event_types.WORLDINFO_UPDATED, () => refreshNames());
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => refreshNames());
}

jQuery(async () => {
    loadSettings();
    await initSettingsUi();
    addMenuButton();
    registerCommand();
    bindEvents();
    await refreshNames();
    if (settings().enabled) mount();
    updatePrompt();
});

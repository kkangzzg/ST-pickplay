// VN 모드 - 호감도 규칙과 캐릭터 기질 (실리태번 비의존)
// 규칙과 수치는 여기서 정하고, AI는 글과 판정만 맡는다.

export const AFFINITY = {
    tiers: [
        { key: 'acquaintance', label: '지인', min: 0 },
        { key: 'friend', label: '친구', min: 30 },
        { key: 'close', label: '호감', min: 60 },
        { key: 'special', label: '특별', min: 80 },
    ],
    // 판정형 호감도: AI는 판정만, 변화량은 코드가 계산 (기질 배율을 곱한다)
    grades: { '++': 5, '+': 2, '0': 0, '-': -2, '--': -6 },
    // 최근 4턴 동안 한 캐릭터의 변화 합계를 이 범위 안으로 묶는다
    cap: 12,
    window: 4,
    // 단계별 오르는 배율 (지인, 친구, 호감, 특별 …). 높은 단계일수록 같은 판정에도 덜 오른다
    slowdown: [1, 1, 0.6, 0.35],
};

export function tierOf(v) {
    let t = AFFINITY.tiers[0];
    for (const x of AFFINITY.tiers) if (v >= x.min) t = x;
    return t;
}

/** 기질 생성에 보내는 카드 설명 (자료 고르기의 토큰 수도 이 글로 센다) */
export function traitsCardText(card) {
    if (!card) return '';
    return [
        `Name: ${card.name}`,
        card.description ? `Description: ${String(card.description).trim()}` : '',
        card.personality ? `Personality: ${String(card.personality).trim()}` : '',
    ].filter(Boolean).join('\n');
}

/** 기질 생성에 보내는 로어북 항목 하나 */
export function traitsLoreText(e) {
    return `### ${e.title}\n${String(e.content).trim()}\n`;
}

/**
 * 호감도 상승·하락 속도 분석 프롬프트. 유저가 "속도 분석"에서 고른 자료만 보낸다 (자르지 않는다).
 * 취향 목록은 만들지 않는다: 요약하면 성격의 뉘앙스가 깎여서, 판정은 대화 맥락의 원래 캐릭터 설정과 유저 메모로 한다
 * @param {object} p { names: string[], card: {name, description, personality}|null, lore: [{title, content}] }
 */
export function buildTraitsPrompt({ names, card, lore }) {
    const loreText = lore.map(traitsLoreText).join('');
    const system = [
        'You read character sheets and rate how quickly each character warms up to, and cools toward, the player.',
        'Answer with one JSON object only, no commentary, no code fence.',
    ].join('\n');
    const prompt = [
        card ? '## Character card\n' + traitsCardText(card) : '',
        loreText ? '\n## Lorebook\n' + loreText : '',
        '## Task',
        `For each of these characters: ${names.join(', ')}`,
        'Return this JSON shape:',
        JSON.stringify({ traits: [{ name: 'exact name from the list', gain: 1.0, loss: 1.0 }] }, null, 1),
        'Rules:',
        '- gain and loss are multipliers from 0.5 to 1.5. A guarded character gains slowly (0.5-0.8) and loses fast (1.2-1.5). An easygoing one gains fast and loses slowly. Fit them to the personality.',
        '- Use the exact names from the list. Skip a name only if it is clearly not a person.',
    ].filter(x => x !== '').join('\n');
    return { system, prompt };
}

/** 응답에서 JSON을 꺼낸다 */
export function parseJsonLoose(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('JSON을 찾지 못했어요');
    return JSON.parse(s.slice(start, end + 1));
}

export const clampMult = (v) => Math.max(0.5, Math.min(1.5, Number(v) || 1));

/** 분석 결과 → { 이름: {gain, loss} } (목록에 없는 이름은 버린다) */
export function parseTraits(raw, names) {
    const allowed = new Set(names);
    const out = {};
    for (const t of Array.isArray(raw?.traits) ? raw.traits : []) {
        const name = String(t?.name || '').trim();
        if (!allowed.has(name)) continue;
        out[name] = {
            gain: clampMult(t.gain),
            loss: clampMult(t.loss),
        };
    }
    if (!Object.keys(out).length) throw new Error('캐릭터 기질이 비어 있어요');
    return out;
}

// VN 모드 - BGM · 효과음 재생 (실리태번 비의존)
// 파일 이름(확장자 뺀 것)으로 찾는다. AI는 목록에서 이름을 골라 쓴다.

const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|webm)$/i;
/** bgm에 이 말을 쓰면 음악을 멈춘다 */
const STOP_WORDS = new Set(['정지', '없음', '무음', '끄기', 'stop', 'none', 'off', 'silence']);
const FADE_MS = 900;

export function isAudioFile(name) {
    return AUDIO_EXT.test(String(name || ''));
}

/** 'assets/bgm/평온한 오후.mp3' → '평온한 오후' */
export function soundName(path) {
    const file = decodeURIComponent(String(path || '').split('/').pop() || '');
    return file.replace(AUDIO_EXT, '').trim();
}

/** 비교용: 대소문자·공백·밑줄·하이픈 무시 */
function norm(name) {
    return String(name || '').toLowerCase().replace(AUDIO_EXT, '').replace(/[\s_-]+/g, '');
}

export function isStopWord(name) {
    return STOP_WORDS.has(norm(name));
}

export class PPSound {
    constructor() {
        this.files = { bgm: new Map(), sfx: new Map() };
        this.enabled = false;
        this.muted = false;
        this.vol = { bgm: 0.6, sfx: 0.8 };
        this.want = '';      // 지금 턴이 원하는 곡 이름 (꺼져 있어도 기억해 뒀다가 켜면 튼다)
        this.playing = null; // { key, audio }
    }

    /** @param {{bgm: string[], sfx: string[]}} paths 서버 경로 목록 (assets/bgm/…) */
    setFiles(paths) {
        for (const kind of ['bgm', 'sfx']) {
            const map = new Map();
            for (const p of paths[kind] || []) if (isAudioFile(p)) map.set(norm(soundName(p)), '/' + String(p).replace(/^\/+/, ''));
            this.files[kind] = map;
        }
        this.sync();
    }

    names(kind) {
        return [...this.files[kind].values()].map(soundName);
    }

    hasFiles() {
        return this.files.bgm.size > 0 || this.files.sfx.size > 0;
    }

    configure({ enabled, muted, bgmVolume, sfxVolume }) {
        this.enabled = !!enabled;
        this.muted = !!muted;
        this.vol.bgm = clamp01(bgmVolume / 100);
        this.vol.sfx = clamp01(sfxVolume / 100);
        if (this.playing) this.playing.audio.volume = this.vol.bgm;
        this.sync();
    }

    get active() {
        return this.enabled && !this.muted;
    }

    /** 턴이 바뀔 때마다 부른다. 같은 곡이면 이어서 튼다 */
    setBgm(name) {
        this.want = isStopWord(name) ? '' : String(name || '');
        this.sync();
    }

    playSfx(name) {
        if (!this.active) return;
        const url = this.files.sfx.get(norm(name));
        if (!url) return;
        const a = new Audio(url);
        a.volume = this.vol.sfx;
        a.play().catch(() => {});
    }

    stop() {
        this.want = '';
        this.sync();
    }

    sync() {
        const url = this.active && this.want ? this.files.bgm.get(norm(this.want)) : null;
        if (this.playing?.key === url) {
            if (url && this.playing.audio.paused) this.playing.audio.play().catch(() => {});
            return;
        }
        if (this.playing) fadeOut(this.playing.audio);
        this.playing = null;
        if (!url) return;
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0;
        this.playing = { key: url, audio };
        audio.play().then(() => fadeTo(audio, this.vol.bgm)).catch(() => {});
    }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
}

function fadeTo(audio, target, ms = FADE_MS, done) {
    clearInterval(audio._ppFade);
    const from = audio.volume;
    const start = performance.now();
    audio._ppFade = setInterval(() => {
        const k = Math.min(1, (performance.now() - start) / ms);
        audio.volume = clamp01(from + (target - from) * k);
        if (k >= 1) { clearInterval(audio._ppFade); done?.(); }
    }, 40);
}

function fadeOut(audio) {
    fadeTo(audio, 0, FADE_MS, () => { audio.pause(); audio.src = ''; });
}

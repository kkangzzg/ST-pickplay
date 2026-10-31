// VN 모드 - CG 썸네일 (실리태번 비의존)
// LOG·CG 격자에서 장당 1.6MB짜리 원본 대신 작은 썸네일을 쓴다.
// 실리태번 데이터 폴더에는 아무것도 저장하지 않고, 브라우저 저장소(IndexedDB)에만 둔다.
// 지워져도 원본에서 다시 만들 뿐이라 잃는 것은 없다.

/** 채팅의 CG가 이 수 이상일 때만 썸네일을 쓴다 */
export const THUMB_THRESHOLD = 60;

const DB_NAME = 'PickPlay_Thumbnails';
/** 예전 이름의 저장소 (가운데 자르기 기준으로 만든 썸네일). 쓰지 않으니 한 번 지운다 */
const OLD_DB_NAMES = ['VNMode_Thumbnails'];
const STORE = 'thumbs';
const WIDTH = 320;
const HEIGHT = 180;
const MAX_PARALLEL = 2;
/** 자르는 기준이 바뀌면 올린다 (예전 기준으로 만든 저장본을 다시 만들게) */
const KEY_VERSION = 'v2:';

try { for (const name of OLD_DB_NAMES) indexedDB.deleteDatabase(name); } catch { /* 지우지 못해도 쓰지 않을 뿐 */ }

const memory = new Map(); // 원본 주소 → 썸네일 blob 주소 (이번 세션)
const pending = new Map(); // 원본 주소 → 만드는 중인 Promise
const queue = [];
let running = 0;
let dbPromise = null;

/** 저장소 열기. 저장 칸이 없는 채로 먼저 만들어진 경우에도 버전을 올려 칸을 만든다 */
function openDb() {
    if (!dbPromise) {
        const open = (version) => new Promise((resolve) => {
            try {
                const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
                };
                req.onsuccess = () => {
                    // 다른 탭이 버전을 올리려 하면 내 연결을 닫아 막지 않는다
                    req.result.onversionchange = () => req.result.close();
                    resolve(req.result);
                };
                req.onerror = () => resolve(null);
                // 다른 탭이 열고 있어 막히면 영원히 기다리지 않고 저장소 없이 간다 (썸네일은 이번 세션 메모리로만)
                req.onblocked = () => resolve(null);
                setTimeout(() => resolve(null), 3000);
            } catch {
                resolve(null);
            }
        });
        dbPromise = (async () => {
            const db = await open();
            if (!db || db.objectStoreNames.contains(STORE)) return db;
            const next = db.version + 1;
            db.close();
            return open(next);
        })();
    }
    return dbPromise;
}

async function dbGet(key) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function dbPut(key, blob) {
    const db = await openDb();
    if (!db) return;
    try {
        db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key);
    } catch { /* 저장 못 해도 이번 세션 메모리에는 있다 */ }
}

/** 원본을 불러와 320×180 WebP로 줄인다. 가로는 가운데, 세로로 넘치면 위쪽 1/4 지점을 기준으로 자른다 (세로 그림 얼굴이 남게) */
function render(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = WIDTH;
            canvas.height = HEIGHT;
            const ctx = canvas.getContext('2d');
            const scale = Math.max(WIDTH / img.naturalWidth, HEIGHT / img.naturalHeight);
            const w = img.naturalWidth * scale;
            const h = img.naturalHeight * scale;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, (WIDTH - w) / 2, (HEIGHT - h) * (h > HEIGHT ? 0.25 : 0.5), w, h);
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/webp', 0.82);
        };
        img.onerror = () => reject(new Error('load'));
        img.src = url;
    });
}

function pump() {
    while (running < MAX_PARALLEL && queue.length) {
        const job = queue.shift();
        running++;
        job().finally(() => { running--; pump(); });
    }
}

/**
 * 썸네일 주소. 메모리 → IndexedDB → 새로 만들기 순서로 찾는다.
 * 만들지 못하면 원본 주소를 돌려준다.
 */
export function getThumb(url) {
    if (!url) return Promise.resolve('');
    if (memory.has(url)) return Promise.resolve(memory.get(url));
    if (pending.has(url)) return pending.get(url);
    const p = new Promise((resolve) => {
        queue.push(() => Promise.race([job(), new Promise(r => setTimeout(r, 12000))]));
        async function job() {
            // 한 장이 멈춰도 줄 전체가 멈추지 않게: 10초 안에 못 만들면 원본을 그대로 보여 준다
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(url); } }, 10000);
            try {
                let blob = await dbGet(KEY_VERSION + url);
                if (!blob) {
                    blob = await render(url);
                    await dbPut(KEY_VERSION + url, blob);
                }
                const objectUrl = URL.createObjectURL(blob);
                memory.set(url, objectUrl);
                if (!done) resolve(objectUrl);
            } catch {
                if (!done) resolve(url);
            } finally {
                done = true;
                clearTimeout(timer);
                pending.delete(url);
            }
        }
        pump();
    });
    pending.set(url, p);
    return p;
}

/** 이미 메모리에 있는 썸네일 (없으면 null) */
export function cachedThumb(url) {
    return memory.get(url) || null;
}

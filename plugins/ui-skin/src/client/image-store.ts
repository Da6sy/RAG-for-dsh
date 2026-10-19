/**
 * Wallpaper assets: the browser-local store and the measurement pass.
 *
 * The design keeps images OUT of the profile (§3.5): the settings section
 * persists only scalars, the picture lives in this origin's IndexedDB, and a
 * profile shared across machines therefore carries no broken image path. One
 * record ("background") holds the Blob plus the facts the settings page and
 * the readability guard need (dimensions, byte size, average grey).
 *
 * Everything here is best-effort: a browser without IndexedDB still gets a
 * session-only wallpaper, and the controller reports the degradation instead
 * of failing the plugin.
 *
 * @module @clue-harness/ui-skin/client/image-store
 */
import { IMAGE_MAX_BYTES, IMAGE_TYPES, type SkinImageMeta } from '../skin-config.ts'

/** The database and object-store identity. */
const DB_NAME = 'clue-ui-skin'
const DB_VERSION = 1
const STORE = 'assets'
const KEY = 'background'

/** One persisted wallpaper record. */
export interface StoredWallpaper {
  blob: Blob
  meta: SkinImageMeta
}

/** A remote image resolved for painting, and whether its bytes are local. */
export interface RemoteWallpaper {
  /** The URL to put in CSS (an object URL when the bytes were fetched). */
  displayUrl: string
  /** Average sRGB grey when the bytes could be measured. */
  grey?: number
  /** Whether the display URL is an owned object URL the caller must revoke. */
  objectUrl: boolean
}

/** Open (and lazily create) the asset database. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB 打开失败')) }
    request.onblocked = () => { reject(new Error('IndexedDB 被其它标签页占用')) }
  })
}

/** Run one transaction against the asset store. */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      transaction.oncomplete = () => {}
      transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB 事务中止')) }
      transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB 事务失败')) }
      const request = run(transaction.objectStore(STORE))
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB 请求失败')) }
    })
  } finally {
    db.close()
  }
}

/** Read the persisted wallpaper, if any. */
export async function readStoredWallpaper(): Promise<StoredWallpaper | undefined> {
  try {
    const record = await withStore<StoredWallpaper | undefined>('readonly', store => store.get(KEY) as IDBRequest<StoredWallpaper | undefined>)
    if (record === undefined || record === null) return undefined
    if (!(record.blob instanceof Blob)) return undefined
    // A record from a future/older shape without measurements is unusable for
    // the settings page and the contrast guard; ask for a fresh upload instead.
    const meta = record.meta as Partial<SkinImageMeta> | undefined
    if (meta === undefined
      || typeof meta.name !== 'string' || typeof meta.bytes !== 'number'
      || typeof meta.width !== 'number' || typeof meta.height !== 'number'
      || typeof meta.grey !== 'number') return undefined
    return { blob: record.blob, meta: meta as SkinImageMeta }
  } catch {
    return undefined
  }
}

/** Persist one wallpaper blob and its metadata. */
export async function writeStoredWallpaper(blob: Blob, meta: SkinImageMeta): Promise<void> {
  await withStore('readwrite', store => store.put({ blob, meta }, KEY))
  // Best effort: ask the browser to keep the asset through storage pressure.
  void navigator.storage?.persist?.().catch(() => undefined)
}

/** Delete the persisted wallpaper (settings reset keeps it; "清除" removes it). */
export async function deleteStoredWallpaper(): Promise<void> {
  try {
    await withStore('readwrite', store => store.delete(KEY))
  } catch {
    // A failed delete only means the old blob stays around; the config no
    // longer points at it, so the visual state is already correct.
  }
}

/** Format a byte count for the settings page. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Validate an upload before any expensive work happens. */
export function validateUpload(file: File): string | undefined {
  if (!IMAGE_TYPES.includes(file.type)) return '只支持 PNG / JPEG / WebP 图片'
  if (file.size > IMAGE_MAX_BYTES) return `图片 ${formatBytes(file.size)} 超过 8 MB 上限,请压缩后再上传`
  if (file.size === 0) return '这个文件是空的'
  return undefined
}

/**
 * Decode an image and compute the facts the settings page and guard need.
 * @param blob - the encoded image bytes.
 * @returns natural dimensions and the average sRGB grey (0–255).
 */
export async function measureImage(blob: Blob): Promise<{ width: number; height: number; grey: number }> {
  const bitmap = await createImageBitmap(blob)
  try {
    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return { width: bitmap.width, height: bitmap.height, grey: 128 }
    context.drawImage(bitmap, 0, 0, size, size)
    const data = context.getImageData(0, 0, size, size).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    }
    const pixels = data.length / 4
    return {
      width: bitmap.width,
      height: bitmap.height,
      grey: pixels === 0 ? 128 : sum / pixels,
    }
  } finally {
    bitmap.close()
  }
}

/** Resolve an `<img>` load (used when a CORS fetch is refused). */
function loadWithElement(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => { resolve() }
    image.onerror = () => { reject(new Error('图片无法加载')) }
    image.src = url
  })
}

/**
 * Resolve a remote wallpaper.
 *
 * The IMAGE element is the paint source of record: CSS backgrounds do not need
 * CORS, so an image that the browser can display is a valid wallpaper even
 * when its server forbids `fetch`. We only fetch bytes for the SAME-ORIGIN
 * case, where the measurement (average grey for the contrast guard) is
 * available without a CORS console error. Cross-origin wallpapers still work;
 * the guard simply falls back to its conservative luminance range.
 *
 * @param url - an http(s) image URL.
 * @returns the URL to paint with, plus the measurement when available.
 * @throws a human-readable Chinese message when the image cannot load at all.
 */
export async function loadRemoteWallpaper(url: string): Promise<RemoteWallpaper> {
  try {
    await loadWithElement(url)
  } catch {
    throw new Error('图片链接加载失败;检查地址是否可访问,或改用本地上传')
  }
  let sameOrigin = false
  try {
    sameOrigin = typeof location !== 'undefined' && new URL(url, location.href).origin === location.origin
  } catch {
    sameOrigin = false
  }
  if (!sameOrigin) return { displayUrl: url, objectUrl: false }
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) return { displayUrl: url, objectUrl: false }
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) return { displayUrl: url, objectUrl: false }
    const measured = await measureImage(blob)
    return { displayUrl: URL.createObjectURL(blob), grey: measured.grey, objectUrl: true }
  } catch {
    return { displayUrl: url, objectUrl: false }
  }
}

/**
 * Minimal local static server (design doc §4.8: never use file://).
 *
 * Browsers block/alter local resource loading under file:// (images, fonts,
 * fetch), which produces failures that do not exist in the real page. Serving
 * the project over http://127.0.0.1 removes that whole class of false bugs.
 *
 * Determinism notes: no-store cache headers (a warm cache must never change
 * capture results) and strict path-confinement under the project root.
 *
 * @module @clue-harness/evidence-render/server
 */
import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** A running static server; close() is idempotent. */
export interface StaticServerHandle {
  /** Origin to build page URLs from (loopback + OS-assigned port). */
  baseUrl: string
  port: number
  close(): Promise<void>
}

/**
 * Serve `rootDir` on a loopback ephemeral port.
 * @param rootDir - absolute project directory (the capture target's root).
 * @returns the running server handle.
 */
export async function serveProject(rootDir: string): Promise<StaticServerHandle> {
  const root = await path.resolve(rootDir)

  const server: Server = createServer((req, res) => {
    res.on('error', () => { /* client aborts mid-response are noise */ })
    const send = (status: number, body: Buffer | string, type: string): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const decoded = decodeURIComponent(url.pathname)
      let filePath = path.resolve(root, `.${path.posix.normalize(decoded)}`)
      if (!filePath.startsWith(root)) {
        send(403, 'forbidden', 'text/plain; charset=utf-8')
        return
      }
      void stat(filePath).then(async (info) => {
        let target = filePath
        if (info.isDirectory()) target = path.join(filePath, 'index.html')
        try {
          const data = await readFile(target)
          send(200, data, MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream')
        } catch {
          send(404, `not found: ${decoded}`, 'text/plain; charset=utf-8')
        }
      }).catch(() => {
        send(404, `not found: ${decoded}`, 'text/plain; charset=utf-8')
      })
    } catch {
      send(400, 'bad request', 'text/plain; charset=utf-8')
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('static server: no bound address')

  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

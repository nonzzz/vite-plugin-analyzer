import { Readable } from 'stream'
import http from 'http'
import net from 'net'
import zlib from 'zlib'
import ansis from 'ansis'
import type { DefaultSizes, Module } from './interface'
import { stringToByte } from './shared'

export interface RenderOptions {
  title: string
  mode: DefaultSizes
}

export interface ServerOptions extends RenderOptions {
  arena: ReturnType<typeof arena>
}

export interface Descriptor {
  kind: 'script' | 'style' | 'title'
  text: string
  attrs?: string[]
}

// https://tc39.es/ecma262/#sec-putvalue
// Using var instead of set attr to window we can reduce 9 bytes
function generateInjectCode(analyzeModule: Module[], mode: string) {
  const { stringify } = JSON
  return `var defaultSizes=${stringify(mode)},analyzeModule=${stringify(analyzeModule)};`
}

// For better integrated, user prefer to pre compile this part without cli. (can reduce nearly 40kb)
// In built mode according flag inject a fake chunk at the output

export async function renderView(analyzeModule: Module[], options: RenderOptions) {
  const { html } = await import('html.mjs')
  return html(options.title, generateInjectCode(analyzeModule, options.mode))
}

export function arena() {
  let hasSet = false
  let binary: Uint8Array
  return {
    rs: new Readable(),
    into(b: string | Uint8Array) {
      if (hasSet) return
      this.rs.push(b)
      this.rs.push(null)
      if (!binary) {
        binary = stringToByte(b)
      }
      hasSet = true
    },
    refresh() {
      hasSet = false
      this.rs = new Readable()
      this.into(binary)
    }
  }
}

export function createStaticMiddleware(options: ServerOptions) {
  return function staticMiddleware(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf8;')
      res.setHeader('Content-Encoding', 'gzip')
      options.arena.rs.pipe(zlib.createGzip()).pipe(res)
      options.arena.refresh()
    }
  }
}

export async function ensureEmptyPort(preferredPort: number) {
  const getPort = () => Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024

  const checkPort = async (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false)
        } else {
          resolve(true)
        }
      })
      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })
      server.listen(port, 'localhost')
    })
  }
  if (preferredPort === 0) {
    let portAvailable = false
    let randomPort = 0
    while (!portAvailable) {
      randomPort = getPort()
      portAvailable = await checkPort(randomPort)
    }
    return randomPort
  }
  let portAvailable = await checkPort(preferredPort)
  if (portAvailable) {
    return preferredPort
  } else {
    let nextPort = preferredPort + 1
    while (true) {
      portAvailable = await checkPort(nextPort)
      if (portAvailable) {
        return nextPort
      }
      nextPort++
    }
  }
}

export async function createServer(port = 0, silent = false) {
  const server = http.createServer()
  const safePort = await ensureEmptyPort(port)

  server.listen(safePort, () => {
    if (silent) return
    console.log('server run on ', ansis.hex('#5B45DE')(`http://localhost:${safePort}`))
  })

  const setup = (options: ServerOptions) => {
    server.on('request', createStaticMiddleware(options))
  }

  return {
    setup,
    get port() {
      return safePort
    }
  }
}

export interface Descriptor {
  kind: 'script' | 'style' | 'title'
  text: string
  attrs?: string[]
}

interface InjectHTMLTagOptions {
  html: string
  injectTo: 'body' | 'head'
  descriptors: Descriptor | Descriptor[]
}

// Refactor this function
export function injectHTMLTag(options: InjectHTMLTagOptions) {
  const regExp = options.injectTo === 'head' ? /([ \t]*)<\/head>/i : /([ \t]*)<\/body>/i
  options.descriptors = Array.isArray(options.descriptors) ? options.descriptors : [options.descriptors]
  const descriptors = options.descriptors.map(d => {
    if (d.attrs && d.attrs.length > 0) {
      return `<${d.kind} ${d.attrs.join(' ')}>${d.text}</${d.kind}>`
    }
    return `<${d.kind}>${d.text}</${d.kind}>`
  })
  return options.html.replace(regExp, (match) => `${descriptors.join('\n')}${match}`)
}

export type { AllowedMagicType, QueryKind } from '../client/special'

import path from 'path'
import type { ZlibOptions } from 'zlib'
import { SourceMapConsumer } from 'source-map'
import { createGzip, pick, slash } from './shared'
import type { OutputChunk, PluginContext } from './interface'

const defaultWd = slash(process.cwd())

function getAbsPath(p: string) {
  p = slash(p)
  return p.replace(defaultWd, '').replace(/\0/, '')
}

function lexPaths(p: string) {
  const dirs = p.split('/')
  if (dirs.length === 1) return dirs
  const paths: string[] = []
  const fileName = dirs.pop()!
  while (dirs.length) {
    const latest = dirs.shift()!
    paths.push(latest)
  }
  return [paths, fileName]
}

function generateNodeId(id: string): string {
  const abs = getAbsPath(id)
  return path.isAbsolute(abs) ? abs.replace('/', '') : abs
}

async function getSourceMapContent(code: string, sourceMap: any) {
  const modules: Record<string, string> = {}
  if (!sourceMap) return {}
  await SourceMapConsumer.with(sourceMap, null, consumer => {
    let line = 1
    let column = 0
    for (let i = 0; i < code.length; i++, column++) {
      const { source } = consumer.originalPositionFor({
        line,
        column
      })
      if (source) {
        const id = source.replace(/\.\.\//g, '')
        if (id in modules) {
          modules[id] += code[i]
        } else {
          modules[id] = code[i]
        }
      }
      if (code[i] === '\n') {
        line += 1
        column = -1
      }
    }
  })
  return modules
}

export class BaseNode {
  id: string
  label: string
  path: string
  // eslint-disable-next-line no-use-before-define
  pairs: Record<string, BaseNode>
  // eslint-disable-next-line no-use-before-define
  children: Array<BaseNode>
  constructor(id: string) {
    this.id = id
    this.label = id
    this.path = id
    this.pairs = Object.create(null)
    this.children = []
  }

  addPairsNode<T extends BaseNode>(key: string, node: T) {
    const currentPairs = this.pairs[key]
    if (currentPairs) return
    node.label = key
    node.path = key
    this.pairs[key] = node
  }

  addPairs<T extends BaseNode>(node: T) {
    this.pairs[node.id] = node
    return node
  }

  getChild(id: string) {
    return this.pairs[id]
  }

  walk<T extends BaseNode>(node: T) {
    if (!Object.keys(node.pairs).length) return
    for (const name in this.pairs) {
      const ref = this.pairs[name]
      ref.walk(ref)
      ref.pairs = {}
      this.children.push(ref)
    }
  }
}

export class SourceNode extends BaseNode {
  parsedSize: number
  gzipSize: number
  constructor(id: string, parsedSize: number, gzipSize: number) {
    super(id)
    this.parsedSize = parsedSize
    this.gzipSize = gzipSize
  }
}

function createSourceNode(id: string, parsedSize: number, gzipSize: number) {
  return new SourceNode(generateNodeId(id), parsedSize, gzipSize)
}

export class StatNode extends BaseNode {
  statSize: number
  constructor(id: string, statSize: number) {
    super(id)
    this.statSize = statSize
  }
}

function createStatNode(id: string, statSize: number) {
  return new StatNode(id, statSize)
}

export class AnalyzerNode extends BaseNode {
  parsedSize: number
  statSize: number
  gzipSize: number
  source: Array<SourceNode>
  stats: Array<StatNode>
  pairs: Record<string, BaseNode>
  imports: Set<string>
  isAsset: boolean
  isEntry: boolean
  constructor(id: string) {
    super(id)
    this.parsedSize = 0
    this.statSize = 0
    this.gzipSize = 0
    this.source = []
    this.stats = []
    this.pairs = Object.create(null)
    this.imports = new Set()
    this.isAsset = true
    this.isEntry = false
  }
  
  private processTreeNode<T extends BaseNode>(node: T) {
    const paths = lexPaths(node.id)
    if (paths.length === 1) {
      this.addPairsNode(node.id, node)
      return
    }
    const [folders, fileName] = paths as [string[], string]
    let reference: BaseNode = this
    folders.forEach((folder) => {
      let childNode = reference.getChild(folder)
      if (!childNode) childNode = reference.addPairs(new BaseNode(folder))
      reference = childNode
    })
    if (fileName) {
      reference.addPairsNode(fileName, node)
    }
  }

  addImports(...imports: string[]) {
    imports.forEach((imp) => this.imports.add(imp))
  }

  async setup(bundle: OutputChunk, pluginContext: PluginContext, compress: ReturnType<typeof createGzip>) {
    const modules = bundle.modules
    const source = await getSourceMapContent(bundle.code, bundle.map)
    for (const moduleId in modules) {
      const info = pluginContext.getModuleInfo(moduleId)
      if (!info) continue
      const { id } = info
      if (/\.(js|mjs|cjs)$/.test(id) || id.startsWith('\0')) {
        const node = createStatNode(id, modules[moduleId].originalLength)
        this.stats.push(node)
      }
    }
    for (const sourceId in source) {
      if (!bundle.moduleIds.length) continue
      const matched = bundle.moduleIds.find(id => id.match(sourceId))
      if (matched) {
        const code = Buffer.from(source[sourceId], 'utf8')
        const result = await compress(code)
        this.source.push(createSourceNode(matched, code.byteLength, result.byteLength))
      }
    }
    this.stats = this.prepareNestedNodes(this.stats)
    this.children = []
    this.source = this.prepareNestedNodes(this.source)
    this.children = []
    this.isEntry = bundle.isEntry
    this.stats = this.stats.map(stat => this.traverse(stat))
    this.source = this.source.map(s => this.traverse(s))
  }

  private prepareNestedNodes<T extends BaseNode>(nodes: T[]) {
    while (nodes.length) {
      const current = nodes.shift()
      if (!current) break
      this.processTreeNode(current)
    }
    this.walk(this)
    this.pairs = {}
    return this.children as T[]
  }

  private traverse<T>(node: BaseNode): T {
    if (!node.children.length) {
      if (node instanceof StatNode) {
        return pick(node, ['id', 'path', 'label', 'statSize']) as T
      }
      if (node instanceof SourceNode) {
        return pick(node, ['id', 'path', 'label', 'parsedSize', 'gzipSize']) as T
      }
    }
    const children = node.children.map(child => this.traverse(child))
    if (children.length === 1 && !path.extname(node.id)) {
      const merged = <any>{}
      const childNode = children[0] as any
      merged.id = `${node.id}${childNode.id}`
      merged.label = `${node.label}/${childNode.label}`
      merged.path = `${node.path}/${childNode.path}`
      Object.assign(merged, pick(childNode, ['parsedSize', 'gzipSize', 'statSize', 'children']))
      return merged
    }
    return { ...pick(node, ['id', 'path', 'label']), children } as T
  }
}

function createAnalyzerNode(id: string) {
  return new AnalyzerNode(generateNodeId(id))
}

export class AnalyzerModule {
  compress: ReturnType<typeof createGzip>
  modules: AnalyzerNode[]
  pluginContext: PluginContext | null
  constructor(opt?: ZlibOptions) {
    this.compress = createGzip(opt)
    this.modules = []
    this.pluginContext = null
  }

  installPluginContext(context: PluginContext) {
    if (this.pluginContext) return 
    this.pluginContext = context
  }

  async addModule(bundleName: string, bundle: OutputChunk) {
    const node = createAnalyzerNode(bundleName)
    node.addImports(...bundle.imports, ...bundle.dynamicImports)
    await node.setup(bundle, this.pluginContext!, this.compress)
    this.modules.push(node)
  }

  processFoamModule() {
  }
}

export function createAnalyzerModuleV2(opt?: ZlibOptions) {
  return new AnalyzerModule(opt)
}

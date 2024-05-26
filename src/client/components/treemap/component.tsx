import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { ForwardedRef } from 'react'
import { useApplicationContext } from '../../context'
import type { Sizes } from '../../interface'
import { createTreemap } from './treemap'
import { Module } from './interface'
import { sortChildrenBySize } from './shared'

function handleModule(data: Module, size: Sizes) {
  if (Array.isArray(data.groups)) {
    data.groups = data.groups.map((m) => handleModule(m, size)).sort(sortChildrenBySize)
  }
  return { ...data, size: data[size] }
}

interface TreemapProps {
}

export type TreemapInstance = ReturnType<typeof createTreemap>

// We need sort the chunks by byte. We can't sort the chunks at backend side, because we can't determine the order.

export const Treemap = forwardRef((props: TreemapProps, ref: ForwardedRef<TreemapInstance>) => {
  const treemapInstance = useRef<TreemapInstance | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { analyzeModule, sizes, scence } = useApplicationContext()

  useImperativeHandle(ref, () => treemapInstance.current!)

  const visibleChunks = useMemo(() => {
    return analyzeModule.filter(m => scence.has(m.label))
      .map(m => {
        m.groups = sizes === 'statSize' ? m.stats : m.source
        return handleModule(m, sizes)
      })
  }, [analyzeModule, sizes, scence])

  const resize = () => {
    if (!treemapInstance.current) return
    treemapInstance.current.resize()
  }

  useEffect(() => {
    if (!treemapInstance.current && containerRef.current) {
      const treemap = createTreemap(visibleChunks)
      treemapInstance.current = treemap
      treemapInstance.current.mount(containerRef.current!)
      window.addEventListener('resize', resize)
    }
    return () => {
      if (!treemapInstance.current) return
      window.removeEventListener('resize', resize)
      treemapInstance.current?.dispose()
      treemapInstance.current = null
    }
  }, [visibleChunks])

  return <div ref={containerRef} stylex={{ height: '100%', width: '100%', position: 'relative' }} />
})

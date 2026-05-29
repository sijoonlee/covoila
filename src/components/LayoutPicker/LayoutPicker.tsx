import type { Layout } from '../../types'
import { layoutOptions } from '../../mockData'
import styles from './LayoutPicker.module.css'

type Props = {
  current: Layout
  onSelect: (layout: Layout) => void
}

export default function LayoutPicker({ current, onSelect }: Props) {
  return (
    <div className={styles.picker}>
      {layoutOptions.map(opt => (
        <button
          key={opt.id}
          className={`${styles.option} ${opt.id === current ? styles.active : ''}`}
          onClick={() => onSelect(opt.id)}
        >
          <LayoutIcon layout={opt.id} />
          <span className={styles.label}>{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

function LayoutIcon({ layout }: { layout: Layout }) {
  const sz = 32
  const pad = 3
  const gap = 2
  const inner = sz - pad * 2

  switch (layout) {
    case 'single':
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={inner} height={inner} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    case '2col': {
      const w = (inner - gap) / 2
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={w} height={inner} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + w + gap} y={pad} width={w} height={inner} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    case '2row': {
      const h = (inner - gap) / 2
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={inner} height={h} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad} y={pad + h + gap} width={inner} height={h} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    case '2x2': {
      const cw = (inner - gap) / 2
      const ch = (inner - gap) / 2
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={cw} height={ch} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + cw + gap} y={pad} width={cw} height={ch} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad} y={pad + ch + gap} width={cw} height={ch} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + cw + gap} y={pad + ch + gap} width={cw} height={ch} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    case 'main+2': {
      const mainW = Math.round(inner * 0.6)
      const sideW = inner - mainW - gap
      const sideH = (inner - gap) / 2
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={mainW} height={inner} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + mainW + gap} y={pad} width={sideW} height={sideH} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + mainW + gap} y={pad + sideH + gap} width={sideW} height={sideH} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    case 'top+2': {
      const halfH = (inner - gap) / 2
      const halfW = (inner - gap) / 2
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={inner} height={halfH} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad} y={pad + halfH + gap} width={halfW} height={halfH} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + halfW + gap} y={pad + halfH + gap} width={halfW} height={halfH} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    case '3col': {
      const w = (inner - gap * 2) / 3
      return (
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <rect x={pad} y={pad} width={w} height={inner} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + w + gap} y={pad} width={w} height={inner} fill="currentColor" opacity={0.5} rx={1} />
          <rect x={pad + w * 2 + gap * 2} y={pad} width={w} height={inner} fill="currentColor" opacity={0.5} rx={1} />
        </svg>
      )
    }
    default:
      return null
  }
}

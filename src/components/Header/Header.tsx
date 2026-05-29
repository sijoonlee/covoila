import { useState, useRef, useEffect } from 'react'
import type { AppView, Layout } from '../../types'
import LayoutPicker from '../LayoutPicker/LayoutPicker'
import styles from './Header.module.css'

type Props = {
  activeView: AppView
  layout: Layout
  onViewChange: (view: AppView) => void
  onLayoutChange: (layout: Layout) => void
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [enabled, onClose, ref])
}

export default function Header({
  activeView,
  layout,
  onViewChange,
  onLayoutChange,
}: Props) {
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false)

  const layoutRef = useRef<HTMLDivElement>(null)

  useClickOutside(layoutRef, () => setLayoutPickerOpen(false), layoutPickerOpen)

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.brand}>✈ COVOILA</span>
        <nav className={styles.nav}>
          <button
            className={`${styles.navBtn} ${activeView === 'tasks' ? styles.active : ''}`}
            onClick={() => onViewChange('tasks')}
          >
            TASKS
          </button>
          <button
            className={`${styles.navBtn} ${activeView === 'workflow' ? styles.active : ''}`}
            onClick={() => onViewChange('workflow')}
          >
            WORKFLOW
          </button>
        </nav>
      </div>

      <div className={styles.right}>
        {activeView === 'tasks' && (
          <div className={styles.layoutPickerWrapper} ref={layoutRef}>
            <button
              className={`${styles.iconBtn} ${layoutPickerOpen ? styles.active : ''}`}
              onClick={() => setLayoutPickerOpen(o => !o)}
              title="Layout"
            >
              ⊞
            </button>
            {layoutPickerOpen && (
              <LayoutPicker
                current={layout}
                onSelect={(l) => { onLayoutChange(l); setLayoutPickerOpen(false) }}
              />
            )}
          </div>
        )}
        <button className={styles.iconBtn} title="Settings">⚙</button>
      </div>
    </header>
  )
}

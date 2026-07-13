import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Icon, type IconName } from './icons'
import type { RunStatus, ToastMessage } from './types'

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="加载中" />
}

export function IconButton({
  icon,
  label,
  active,
  className = '',
  ...props
}: {
  icon: IconName
  label: string
  active?: boolean
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  const {
    'aria-label': ariaLabel,
    'aria-pressed': ariaPressed,
    title,
    ...buttonProps
  } = props

  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      {...buttonProps}
      aria-label={ariaLabel ?? label}
      aria-pressed={ariaPressed ?? (active === undefined ? undefined : active)}
      title={title ?? label}
    >
      <Icon name={icon} />
    </button>
  )
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    if (element.tabIndex < 0) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

const STATUS_LABELS: Record<Exclude<RunStatus, 'completed'>, string> = {
  understanding: '正在处理',
  planning: '正在整理',
  running: '正在处理',
  verifying: '正在检查',
  waiting_approval: '需要确认',
  waiting_user: '等你回复',
  paused: '已暂停',
  failed: '未完成',
  cancelled: '已停止',
}

export function StatusBadge({ status, compact = false }: { status: RunStatus; compact?: boolean }) {
  if (status === 'completed') return null
  const label = STATUS_LABELS[status]
  return (
    <span
      className={`status-badge status-${status} ${compact ? 'compact' : ''}`}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
    >
      <span className="status-dot" />
      {!compact && label}
    </span>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: IconName
  title: string
  description: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <div className="empty-icon"><Icon name={icon} size={compact ? 18 : 24} /></div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span />
    </button>
  )
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined

    const dialog = dialogRef.current
    if (!dialog) return undefined

    if (
      !previouslyFocusedRef.current
      && document.activeElement instanceof HTMLElement
      && !dialog.contains(document.activeElement)
    ) {
      previouslyFocusedRef.current = document.activeElement
    }
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      const preferredTarget = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]')
      const target = preferredTarget ?? focusableElements(dialog)[0] ?? dialog
      target.focus()
    })

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const activeElement = document.activeElement

      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousBodyOverflow
      const previouslyFocused = previouslyFocusedRef.current
      previouslyFocusedRef.current = null
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose()}>
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={(event) => {
          const previousTarget = event.relatedTarget
          if (
            !previouslyFocusedRef.current
            && previousTarget instanceof HTMLElement
            && !event.currentTarget.contains(previousTarget)
          ) {
            previouslyFocusedRef.current = previousTarget
          }
        }}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton icon="x" label={`关闭“${title}”`} onClick={onClose} />
        </div>
        {children}
      </section>
    </div>
  )
}

export interface TabItem<T extends string = string> {
  id: T
  label: ReactNode
  ariaLabel?: string
  panel: ReactNode
  disabled?: boolean
}

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  className = '',
  tabListClassName = '',
  tabPanelClassName = '',
}: {
  items: readonly TabItem<T>[]
  value: T
  onValueChange: (value: T) => void
  ariaLabel: string
  className?: string
  tabListClassName?: string
  tabPanelClassName?: string
}) {
  const idPrefix = useId().replace(/:/g, '')
  const tabRefs = useRef(new Map<T, HTMLButtonElement>())
  const enabledItems = items.filter((item) => !item.disabled)
  const selectedId = enabledItems.some((item) => item.id === value)
    ? value
    : enabledItems[0]?.id

  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentId: T) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()

    const currentIndex = enabledItems.findIndex((item) => item.id === currentId)
    if (currentIndex < 0 || enabledItems.length === 0) return

    let nextIndex = currentIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = enabledItems.length - 1
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabledItems.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length

    const nextItem = enabledItems[nextIndex]
    if (!nextItem) return
    onValueChange(nextItem.id)
    tabRefs.current.get(nextItem.id)?.focus()
  }

  return (
    <div className={className}>
      <div className={tabListClassName} role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
        {items.map((item, index) => {
          const selected = item.id === selectedId
          const tabId = `${idPrefix}-tab-${index}`
          const panelId = `${idPrefix}-panel-${index}`
          return (
            <button
              key={item.id}
              ref={(element) => {
                if (element) tabRefs.current.set(item.id, element)
                else tabRefs.current.delete(item.id)
              }}
              id={tabId}
              type="button"
              role="tab"
              aria-label={item.ariaLabel}
              aria-selected={selected}
              aria-controls={panelId}
              aria-disabled={item.disabled || undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.id)}
              onKeyDown={(event) => moveFocus(event, item.id)}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {items.map((item, index) => {
        const selected = item.id === selectedId
        return (
          <div
            key={item.id}
            id={`${idPrefix}-panel-${index}`}
            className={tabPanelClassName}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${index}`}
            tabIndex={selected ? 0 : -1}
            hidden={!selected}
          >
            {item.panel}
          </div>
        )
      })}
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <div className="confirm-content">
        <div className={`confirm-symbol ${danger ? 'danger' : ''}`}>
          <Icon name={danger ? 'warning' : 'info'} size={22} />
        </div>
        <p>{description}</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={onCancel}>取消</button>
        <button type="button" className={`button ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}

export function Toasts({ items, onDismiss }: { items: ToastMessage[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-region" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <div className="toast-icon">
            <Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'error' ? 'warning' : 'info'} size={17} />
          </div>
          <div className="toast-copy">
            <strong>{toast.title}</strong>
            {toast.detail && <span>{toast.detail}</span>}
          </div>
          <IconButton icon="x" label="关闭通知" onClick={() => onDismiss(toast.id)} />
        </div>
      ))}
    </div>
  )
}

export function SubmitForm({ onSubmit, children, className = '' }: { onSubmit: () => void; children: ReactNode; className?: string }) {
  return (
    <form className={className} onSubmit={(event: FormEvent) => {
      event.preventDefault()
      onSubmit()
    }}>
      {children}
    </form>
  )
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

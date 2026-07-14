import React from 'react'
import type { ProcessStepKind, ProcessStepState } from '../../work-turn.types'

interface ProcessIconProps {
  kind: ProcessStepKind
  state?: ProcessStepState
  size?: number
  className?: string
}

function Glyph({ kind }: { kind: ProcessStepKind }) {
  switch (kind) {
    case 'understand': return <><path d="M4 5.5h12M4 10h8M4 14.5h6" /><path d="m14 12 2 2 3-4" /></>
    case 'plan': return <><path d="M6 5h11M6 10h11M6 15h11" /><path d="M2.5 5h.01M2.5 10h.01M2.5 15h.01" /></>
    case 'search': return <><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 5 5M8.5 4a7 7 0 0 1 0 9" /></>
    case 'read_web': return <><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7M10 3c-2 2-3 4.3-3 7s1 5 3 7" /></>
    case 'browser': return <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M3 7h14M5.5 5.25h.01M8 5.25h.01" /></>
    case 'file': return <><path d="M5 2.5h6l4 4v11H5z" /><path d="M11 2.5v4h4M7.5 10h5M7.5 13h5" /></>
    case 'command': return <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m5.5 8 2.5 2-2.5 2M10 12h4" /></>
    case 'connector': return <><path d="M7 7 4.5 4.5M13 13l2.5 2.5M6.5 13.5l-2 2M13.5 6.5l2-2" /><path d="M7 11a3 3 0 0 1 0-4l.5-.5a3 3 0 0 1 4 0M13 9a3 3 0 0 1 0 4l-.5.5a3 3 0 0 1-4 0" /></>
    case 'write': return <><path d="M4 16h3l9-9-3-3-9 9zM11.5 5.5l3 3M4 13l3 3" /><path d="M3 18h14" /></>
    case 'output': return <><path d="M5 3h7l3 3v11H5zM12 3v4h3" /><path d="m8 12 2 2 3-4" /></>
    case 'verify': return <><circle cx="10" cy="10" r="7" /><path d="m6.5 10 2.2 2.2 4.8-5" /></>
    case 'approval': return <><path d="M10 2.5 17 6v4.5c0 3.8-2.5 6-7 7-4.5-1-7-3.2-7-7V6z" /><path d="M10 6.5v4M10 14h.01" /></>
    case 'recovery': return <><path d="M4 8a6.5 6.5 0 1 1 1 6.5" /><path d="M4 3.5V8h4.5" /><path d="m8 10 1.5 1.5L13 8" /></>
    case 'complete': return <><path d="M3 10.5 7.5 15 17 5.5" /><path d="M16.5 10v6.5H4v-13h8" /></>
  }
}

export function ProcessIcon({ kind, state = 'succeeded', size = 20, className = '' }: ProcessIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`process-icon process-icon-${state} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Glyph kind={kind} />
    </svg>
  )
}

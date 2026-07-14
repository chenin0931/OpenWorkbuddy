import React from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight'
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut'
import { BrainIcon as Brain } from '@phosphor-icons/react/Brain'
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown'
import { CheckIcon as Check } from '@phosphor-icons/react/Check'
import { ClockIcon as Clock } from '@phosphor-icons/react/Clock'
import { CopyIcon as Copy } from '@phosphor-icons/react/Copy'
import { DotsThreeIcon as DotsThree } from '@phosphor-icons/react/DotsThree'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/DownloadSimple'
import { FileTextIcon as FileText } from '@phosphor-icons/react/FileText'
import { FolderIcon as Folder } from '@phosphor-icons/react/Folder'
import { GearSixIcon as GearSix } from '@phosphor-icons/react/GearSix'
import { GlobeIcon as Globe } from '@phosphor-icons/react/Globe'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { KeyIcon as Key } from '@phosphor-icons/react/Key'
import { ListChecksIcon as ListChecks } from '@phosphor-icons/react/ListChecks'
import { LockKeyIcon as LockKey } from '@phosphor-icons/react/LockKey'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass'
import { MoonIcon as Moon } from '@phosphor-icons/react/Moon'
import { PaperPlaneTiltIcon as PaperPlaneTilt } from '@phosphor-icons/react/PaperPlaneTilt'
import { PauseIcon as Pause } from '@phosphor-icons/react/Pause'
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/PencilSimple'
import { PlayIcon as Play } from '@phosphor-icons/react/Play'
import { PlugsIcon as Plugs } from '@phosphor-icons/react/Plugs'
import { PlusIcon as Plus } from '@phosphor-icons/react/Plus'
import { PulseIcon as Pulse } from '@phosphor-icons/react/Pulse'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/SidebarSimple'
import { StackIcon as Stack } from '@phosphor-icons/react/Stack'
import { StarIcon as Star } from '@phosphor-icons/react/Star'
import { StopIcon as Stop } from '@phosphor-icons/react/Stop'
import { SunIcon as Sun } from '@phosphor-icons/react/Sun'
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/TerminalWindow'
import { TrashIcon as Trash } from '@phosphor-icons/react/Trash'
import { WarningIcon as Warning } from '@phosphor-icons/react/Warning'
import { XIcon as X } from '@phosphor-icons/react/X'
import type {
  Icon as PhosphorIconComponent,
  IconWeight as PhosphorIconWeight,
} from '@phosphor-icons/react'
import type { SVGProps } from 'react'

/**
 * Product-facing icon names. Keep these semantic names stable so feature code
 * does not depend on a particular icon library.
 */
export type IconName =
  | 'plus'
  | 'search'
  | 'tasks'
  | 'memory'
  | 'plug'
  | 'skill'
  | 'clock'
  | 'settings'
  | 'shield'
  | 'folder'
  | 'chevronDown'
  | 'more'
  | 'send'
  | 'pause'
  | 'play'
  | 'stop'
  | 'check'
  | 'x'
  | 'warning'
  | 'terminal'
  | 'file'
  | 'globe'
  | 'layers'
  | 'activity'
  | 'refresh'
  | 'download'
  | 'key'
  | 'moon'
  | 'sun'
  | 'info'
  | 'arrowRight'
  | 'trash'
  | 'external'
  | 'panelRight'
  | 'edit'
  | 'copy'
  | 'lock'

/** Regular is the default; fill is reserved for selected or attention states. */
export type AppIconWeight = Extract<PhosphorIconWeight, 'regular' | 'fill'>

export type AppIconProps = {
  name: IconName
  size?: number
  weight?: AppIconWeight
  color?: string
} & Omit<SVGProps<SVGSVGElement>, 'color'>

const icons: Record<IconName, PhosphorIconComponent> = {
  plus: Plus,
  search: MagnifyingGlass,
  tasks: ListChecks,
  memory: Brain,
  plug: Plugs,
  skill: Star,
  clock: Clock,
  settings: GearSix,
  shield: ShieldCheck,
  folder: Folder,
  chevronDown: CaretDown,
  more: DotsThree,
  send: PaperPlaneTilt,
  pause: Pause,
  play: Play,
  stop: Stop,
  check: Check,
  x: X,
  warning: Warning,
  terminal: TerminalWindow,
  file: FileText,
  globe: Globe,
  layers: Stack,
  activity: Pulse,
  refresh: ArrowClockwise,
  download: DownloadSimple,
  key: Key,
  moon: Moon,
  sun: Sun,
  info: Info,
  arrowRight: ArrowRight,
  trash: Trash,
  external: ArrowSquareOut,
  panelRight: SidebarSimple,
  edit: PencilSimple,
  copy: Copy,
  lock: LockKey,
}

/**
 * Unified functional icon primitive. Feature code can choose `fill` for an
 * active state while every neutral icon stays on the regular optical weight.
 */
export function AppIcon({
  name,
  size = 18,
  weight = 'regular',
  color = 'currentColor',
  ...props
}: AppIconProps) {
  const Component = icons[name]

  return (
    <Component
      aria-hidden="true"
      color={color}
      size={size}
      weight={weight}
      {...props}
    />
  )
}

/** Backwards-compatible name used throughout the current renderer. */
export function Icon(props: AppIconProps) {
  return <AppIcon {...props} />
}

export type BrandMarkProps = {
  size?: number
  nodeColor?: string
} & SVGProps<SVGSVGElement>

/**
 * Deterministic product mark: two folded work surfaces form a W, with a warm
 * node representing the human approval point. It is intentionally separate
 * from the functional icon set.
 */
export function BrandMark({
  size = 20,
  nodeColor = '#A76513',
  ...props
}: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      {...props}
    >
      <path
        d="M4.5 7.25 9.75 24.5 16 13.25"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m16 13.25 6.25 11.25L27.5 7.25"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.72"
      />
      <path
        d="m10.25 8.25 5.75 5 5.75-5"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.36"
      />
      <circle cx="16" cy="13.25" r="2.35" fill={nodeColor} />
    </svg>
  )
}

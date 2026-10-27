import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChevronDown,
  CircleUser,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Radio,
  Shield,
  Sun,
  UserCog,
} from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'

import { PRODUCT_NAME, CHANNEL_TIMEZONE } from '@/config'
import { useAuth } from '@/hooks/use-auth'
import { useNow } from '@/hooks/use-now'
import { useRealtime } from '@/hooks/use-realtime'
import { useServers } from '@/hooks/use-playout-data'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { useUiStore } from '@/stores/ui-store'
import { PlyoutLogo, Wordmark } from './logo'
import { AgentDot } from '@/components/ui/primitives'

interface NavItem {
  to: string
  label: string
  permission?: string
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/schedule', label: 'Scheduler' },
  { to: '/execlog', label: 'Execution Log' },
  { to: '/system', label: 'System' },
  { to: '/settings', label: 'Settings' },
]

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/pipelines', label: 'Pipelines', permission: 'plyout.view_outputpipeline' },
  { to: '/admin/users', label: 'Users', permission: 'accounts.view_user' },
  { to: '/admin/roles', label: 'Roles', permission: 'accounts.view_role' },
]

/**
 * Authenticated shell: top bar with logo, nav, live clock and user menu
 * (FR-SH-02). The clock ticks at 1 Hz in the channel timezone (FR-SH-04) and
 * the realtime indicator is right next to it so an operator can tell at a
 * glance whether the console is actually live.
 */
export function TopBar() {
  const { session, logout, can, isSuperuser } = useAuth()
  const now = useNow()
  const realtimeStatus = useRealtime()
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, toggleTheme } = useUiStore()
  const { data: servers } = useServers()

  const agentsOnline = (servers ?? []).filter((server) => server.agent_state === 'online').length
  const visibleAdminNav = ADMIN_NAV.filter((item) => !item.permission || can(item.permission))

  const initials =
    (session?.user.first_name?.[0] ?? '') + (session?.user.last_name?.[0] ?? '') || session?.user.username?.[0]?.toUpperCase() || '?'

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
      <Link to="/schedule" className="flex items-center gap-2.5" aria-label={`${PRODUCT_NAME} home`}>
        <PlyoutLogo />
        <Wordmark className="hidden sm:inline-flex" />
      </Link>

      <nav aria-label="Primary" className="flex items-center gap-0.5">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                isActive || location.pathname.startsWith(item.to)
                  ? 'bg-accent-soft text-accent'
                  : 'text-muted hover:bg-hover hover:text-default',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-2 h-5 w-px bg-line" role="presentation" />

      {visibleAdminNav.length > 0 && (
        <nav aria-label="Configuration" className="flex items-center gap-0.5">
          {visibleAdminNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  isActive || location.pathname.startsWith(item.to)
                    ? 'bg-accent-soft text-accent'
                    : 'text-subtle hover:bg-hover hover:text-default',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-4">
        {/* Agent presence. A console showing all-offline is a red flag even if
            the API is healthy, so it is given its own labelled dot. */}
        <span
          className="hidden items-center gap-1.5 rounded-md bg-sunken px-2 py-1 text-2xs text-muted md:inline-flex"
          title={`${agentsOnline} of ${servers?.length ?? 0} playout agents online`}
        >
          <Radio className="h-3 w-3 text-subtle" aria-hidden />
          Agents
          <AgentDot state={agentsOnline > 0 ? 'online' : 'offline'} />
          <span className="tnum text-default">
            {agentsOnline}/{servers?.length ?? 0}
          </span>
        </span>

        <RealtimeIndicator status={realtimeStatus} />

        <div className="hidden text-right sm:block">
          <div className="tnum text-sm font-semibold leading-none text-default">
            {formatClock(new Date(now).toISOString(), CHANNEL_TIMEZONE)}
          </div>
          <div className="mt-0.5 text-[10px] leading-none text-subtle">{CHANNEL_TIMEZONE}</div>
        </div>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md py-1 pl-1 pr-1.5 transition-colors hover:bg-hover"
              aria-label="Account menu"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-2xs font-bold text-accent">
                {initials}
              </span>
              <span className="hidden max-w-28 truncate text-xs font-medium text-default lg:inline">
                {session?.user.username}
              </span>
              <ChevronDown className="h-3 w-3 text-subtle" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="animate-in-fade z-50 min-w-56 rounded-lg border border-line bg-raised p-1 shadow-lg"
            >
              <div className="px-2 py-1.5">
                <p className="truncate text-xs font-semibold text-default">{session?.user.username}</p>
                <p className="truncate text-2xs text-subtle">{session?.user.email}</p>
                {isSuperuser && (
                  <p className="mt-1 inline-flex items-center gap-1 text-2xs font-medium text-warn">
                    <Shield className="h-3 w-3" /> Superuser
                  </p>
                )}
              </div>

              <DropdownMenu.Separator className="my-1 h-px bg-line" />

              <MenuItem icon={<KeyRound className="h-3.5 w-3.5" />} onSelect={() => navigate('/change-password')}>
                Change password
              </MenuItem>
              <MenuItem icon={<UserCog className="h-3.5 w-3.5" />} onSelect={() => navigate('/profile')}>
                Profile
              </MenuItem>
              <MenuItem
                icon={theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                onSelect={toggleTheme}
              >
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </MenuItem>

              <DropdownMenu.Separator className="my-1 h-px bg-line" />

              <MenuItem
                icon={<LogOut className="h-3.5 w-3.5" />}
                tone="danger"
                onSelect={async () => {
                  await logout()
                  navigate('/login', { replace: true })
                }}
              >
                Sign out
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  )
}

function MenuItem({
  icon,
  children,
  onSelect,
  tone = 'default',
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onSelect: () => void
  tone?: 'default' | 'danger'
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-xs outline-none',
        'data-[highlighted]:bg-hover',
        tone === 'danger' ? 'text-danger data-[highlighted]:bg-danger-soft' : 'text-default',
      )}
    >
      <span className="text-subtle">{icon}</span>
      {children}
    </DropdownMenu.Item>
  )
}

/** FR-SH-06 / FR-RT-05: quiet, but never invisible. */
function RealtimeIndicator({ status }: { status: ReturnType<typeof useRealtime> }) {
  const config = {
    connected: { label: 'Live', dot: 'bg-ok', text: 'text-ok' },
    connecting: { label: 'Connecting', dot: 'bg-warn animate-pulse', text: 'text-warn' },
    reconnecting: { label: 'Reconnecting', dot: 'bg-warn animate-pulse', text: 'text-warn' },
    offline: { label: 'Polling', dot: 'bg-subtle', text: 'text-subtle' },
  }[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium',
        'bg-sunken',
        config.text,
      )}
      title={
        status === 'connected'
          ? 'Realtime channel connected'
          : 'Realtime unavailable — the console falls back to 30-second polling'
      }
    >
      <Monitor className="h-3 w-3" aria-hidden />
      <span className={cn('h-1.5 w-1.5 rounded-full', config.dot)} aria-hidden />
      {config.label}
    </span>
  )
}

export { CircleUser }
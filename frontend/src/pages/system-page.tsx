import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Copy,
  Eye,
  MonitorPlay,
  Radio,
  RefreshCw,
  Server as ServerIcon,
} from 'lucide-react'

import { CHANNEL_TIMEZONE } from '@/config'
import {
  useBridgeDeliveries,
  usePipelines,
  useReinitPreview,
  useReinitStream,
  useServerEngineState,
  useServers,
} from '@/hooks/use-playout-data'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/cn'
import { formatFull, formatRelativeTime } from '@/lib/format'
import { notify } from '@/stores/notification-store'
import { useUiStore } from '@/stores/ui-store'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  AgentDot,
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Spinner,
} from '@/components/ui/primitives'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Tooltip } from '@/components/ui/tooltip'

/**
 * System tab (FR-SYS-01 .. FR-SYS-06).
 *
 * The three stream fields are shown **verbatim**. They are not URLs: they are
 * raw CasparCG/ffmpeg argument strings that the agent interpolates into AMCP
 * commands with no quoting (Spec §1.2.1). Trimming, pretty-printing or
 * "fixing" them here would break the broadcast path, so the display is a
 * monospace read-only copy and nothing else.
 */
export function SystemPage() {
  const { can, isSuperuser } = useAuth()
  const canReinit = isSuperuser || can('plyout.reinit_pipeline')

  const pipelinesQuery = usePipelines()
  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data])
  const serversQuery = useServers()
  const servers = useMemo(() => serversQuery.data ?? [], [serversQuery.data])

  const activePipelineId = useUiStore((state) => state.activePipelineId)
  const setActivePipelineId = useUiStore((state) => state.setActivePipelineId)

  useEffect(() => {
    if (activePipelineId === null && pipelines.length > 0) setActivePipelineId(pipelines[0].id)
  }, [activePipelineId, pipelines, setActivePipelineId])

  const pipeline = pipelines.find((entry) => entry.id === activePipelineId) ?? pipelines[0] ?? null

  const engineState = useServerEngineState(pipeline?.server ?? null)
  const deliveries = useBridgeDeliveries(pipeline?.server)
  const reinitStream = useReinitStream(pipeline?.id ?? 0)
  const reinitPreview = useReinitPreview(pipeline?.id ?? 0)
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const pending = useMemo(
    () => (deliveries.data ?? []).filter((entry) => entry.status === 'PENDING'),
    [deliveries.data],
  )

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      notify.warning('Could not copy', 'Clipboard access was refused by the browser.')
    }
  }

  if (pipelinesQuery.isLoading) return <div className="flex h-full items-center justify-center"><Spinner label="Loading channels…" /></div>

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="System"
        description="Output channel configuration and agent control."
        actions={
          <>
            <Select
              value={pipeline ? String(pipeline.id) : ''}
              onValueChange={(value) => setActivePipelineId(Number(value))}
              options={pipelines.map((entry) => ({
                value: String(entry.id),
                label: `${entry.server_name} · ${entry.name}`,
              }))}
              placeholder="Select a channel"
              className="w-72"
              aria-label="Channel"
            />
            <Tooltip content="Re-init the source ingest and the air output (source + destination).">
              <Button
                size="sm"
                variant="primary"
                disabled={!pipeline || !canReinit}
                loading={reinitStream.isPending}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => pipeline && reinitStream.mutate()}
              >
                Reinit stream
              </Button>
            </Tooltip>
            <Tooltip content="Re-init the low-resolution preview output only.">
              <Button
                size="sm"
                variant="secondary"
                disabled={!pipeline || !canReinit}
                loading={reinitPreview.isPending}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => pipeline && reinitPreview.mutate()}
              >
                Reinit preview
              </Button>
            </Tooltip>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {!pipeline ? (
            <Panel>
              <EmptyState
                icon={<MonitorPlay className="h-5 w-5" />}
                title="No output channels"
                description="Create a playout channel under Configuration → Pipelines."
              />
            </Panel>
          ) : (
            <>
              {/* --- agent state --- */}
              <Panel title="Agent" description={pipeline.server_name}>
                <dl className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
                  <Fact
                    label="State"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <AgentDot state={pipeline.engine_state} />
                        <span className="capitalize">{engineState.data?.state ?? pipeline.engine_state}</span>
                      </span>
                    }
                  />
                  <Fact
                    label="Last heartbeat"
                    value={
                      engineState.data?.heartbeat_at ? (
                        <span title={formatFull(engineState.data.heartbeat_at, CHANNEL_TIMEZONE)}>
                          {formatRelativeTime(engineState.data.heartbeat_at, CHANNEL_TIMEZONE)}
                        </span>
                      ) : (
                        'never'
                      )
                    }
                  />
                  <Fact label="Agent version" value={engineState.data?.engine_version || '—'} />
                  <Fact
                    label="Queued pushes"
                    value={
                      <span className={pending.length > 0 ? 'text-warn' : undefined}>
                        {engineState.data?.pending_deliveries ?? 0}
                      </span>
                    }
                  />
                </dl>
              </Panel>

              {/* --- deferred deliveries (FR-SYS-06) --- */}
              {pending.length > 0 && (
                <div className="rounded-xl border border-line border-l-2 border-l-warn bg-warn-soft px-4 py-3">
                  <p className="flex items-center gap-2 text-xs font-medium text-default">
                    <AlertTriangle className="h-4 w-4 text-warn" />
                    {pending.length} command{pending.length === 1 ? '' : 's'} waiting for the agent
                  </p>
                  <p className="mt-1 text-2xs leading-relaxed text-muted">
                    Changes to this channel were saved but the playout agent was unreachable. They are
                    queued and will be retried automatically with backoff — nothing is lost, but the
                    agent will not act on them until it reconnects.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {pending.slice(0, 5).map((entry) => (
                      <li key={entry.id} className="flex items-center gap-2 text-2xs text-muted">
                        <code className="font-mono text-default">{entry.command}</code>
                        <span className="text-subtle">
                          · {entry.attempts} attempt{entry.attempts === 1 ? '' : 's'}
                        </span>
                        {entry.last_error && (
                          <span className="truncate text-subtle">· {entry.last_error}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* --- stream config --- */}
              <Panel
                title="Stream configuration"
                description="These are raw CasparCG / ffmpeg argument strings. They are passed to the agent verbatim and must never be reformatted."
                bodyClassName="space-y-4 p-4"
              >
                <StreamField
                  icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
                  label="Source (ingest → buffer channel)"
                  description={`Played on channel ${pipeline.secondary_channel_number} layer ${pipeline.secondary_receiver_layer}`}
                  value={pipeline.stream_source_url}
                  copied={copied === 'source'}
                  onCopy={() => copy('source', pipeline.stream_source_url)}
                />
                <StreamField
                  icon={<ArrowUpFromLine className="h-3.5 w-3.5" />}
                  label="Destination (air output)"
                  description={`Encoded to channel ${pipeline.primary_channel_number} consumer 99`}
                  value={pipeline.output_destination_url}
                  copied={copied === 'destination'}
                  onCopy={() => copy('destination', pipeline.output_destination_url)}
                />
                <StreamField
                  icon={<Eye className="h-3.5 w-3.5" />}
                  label="Preview output"
                  description={`Low-resolution monitor feed on channel ${pipeline.primary_channel_number} consumer 98`}
                  value={pipeline.preview_stream_url}
                  copied={copied === 'preview'}
                  onCopy={() => copy('preview', pipeline.preview_stream_url)}
                />

                {pipeline.preview_embed_url && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowPreview(true)}
                    icon={<Eye className="h-3.5 w-3.5" />}
                  >
                    Open preview player
                  </Button>
                )}
              </Panel>
            </>
          )}
        </div>

        {/* --- layer map + channels --- */}
        <div className="space-y-4">
          {pipeline && <LayerMap pipeline={pipeline} />}

          <Panel title="Channels" bodyClassName="max-h-[320px] overflow-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Channel</TH>
                  <TH>Agent</TH>
                  <TH className="w-20 text-right">Air</TH>
                </tr>
              </THead>
              <TBody>
                {pipelines.map((entry) => (
                  <TR key={entry.id} selected={entry.id === pipeline?.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Radio className="h-3 w-3 text-subtle" />
                        <span className="text-xs font-medium text-default">{entry.name}</span>
                      </span>
                      <span className="block pl-5 text-[10px] text-subtle">{entry.server_name}</span>
                    </TD>
                    <TD>
                      <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
                        <AgentDot state={entry.engine_state} />
                        {entry.engine_state}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-right">
                        {entry.is_on_air ? (
                          <Badge tone="danger">ON AIR</Badge>
                        ) : (
                          <Badge tone="muted">standby</Badge>
                        )}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>

          <Panel title="Servers" bodyClassName="max-h-[240px] overflow-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Server</TH>
                  <TH>State</TH>
                  <TH className="w-16 text-right">Channels</TH>
                </tr>
              </THead>
              <TBody>
                {servers.map((server) => (
                  <TR key={server.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <ServerIcon className="h-3 w-3 text-subtle" />
                        <span className="text-xs font-medium text-default">{server.name}</span>
                      </span>
                      <span className="block pl-5 font-mono text-[10px] text-subtle">
                        {server.ip_address}:{server.amcp_port}
                      </span>
                    </TD>
                    <TD>
                      <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
                        <AgentDot state={server.agent_state} />
                        {server.agent_state}
                      </span>
                    </TD>
                    <TD numeric>
                      <span className="tnum text-xs text-default">{server.pipeline_count}</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
        </div>
      </div>

      <Modal
        open={showPreview}
        onOpenChange={setShowPreview}
        title={`Preview — ${pipeline?.name ?? ''}`}
        description="Live low-resolution monitor feed produced by the engine."
        size="lg"
      >
        <div className="aspect-video w-full overflow-hidden rounded-lg border border-line bg-black">
          <iframe
            src={pipeline?.preview_embed_url}
            title="Preview player"
            className="h-full w-full"
            allow="autoplay; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------

function StreamField({
  icon,
  label,
  description,
  value,
  copied,
  onCopy,
}: {
  icon: React.ReactNode
  label: string
  description: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-default">
          <span className="text-subtle">{icon}</span>
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          disabled={!value}
          className={cn(
            'inline-flex items-center gap-1 text-2xs font-medium transition-colors',
            copied ? 'text-ok' : 'text-subtle hover:text-default',
          )}
        >
          <Copy className="h-3 w-3" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <Textarea
        readOnly
        value={value}
        rows={value.length > 140 ? 4 : 2}
        hint={description}
        className="cursor-text select-all"
      />
    </div>
  )
}

/**
 * CasparCG layer map (FR-SLS-05).
 *
 * Read-only reference. The consumer layers 99/98 and the SCG lanes 2/3/4 are
 * engine-side constants, not database columns, which is exactly why an operator
 * needs this on screen: the numbers they see in a log are not editable here.
 */
function LayerMap({ pipeline }: { pipeline: import('@/api/types').Pipeline }) {
  const rows = [
    { target: `Ch${pipeline.primary_channel_number} : layer ${pipeline.primary_playout_layer}`, purpose: 'PROGRAM — live route or ad chain', tone: 'accent' as const },
    { target: `Ch${pipeline.primary_channel_number} : layer ${pipeline.primary_graphics_layer}`, purpose: 'GRAPHICS — CG overlay', tone: 'info' as const },
    { target: `Ch${pipeline.primary_channel_number} : consumer 99`, purpose: 'AIR OUT (ffmpeg → RTMP)', tone: 'danger' as const },
    { target: `Ch${pipeline.primary_channel_number} : consumer 98`, purpose: 'PREVIEW OUT', tone: 'muted' as const },
    { target: `Ch${pipeline.secondary_channel_number} : layer ${pipeline.secondary_receiver_layer}`, purpose: 'LIVE SOURCE (SRT ingest)', tone: 'ok' as const },
    { target: `Ch${pipeline.secondary_channel_number} : layer 2`, purpose: 'TICKER', tone: 'muted' as const },
    { target: `Ch${pipeline.secondary_channel_number} : layer 3`, purpose: 'BUG', tone: 'muted' as const },
    { target: `Ch${pipeline.secondary_channel_number} : layer 4`, purpose: 'DOG', tone: 'muted' as const },
  ]

  return (
    <Panel
      title="Layer map"
      description={`Whole-channel route-back: ${pipeline.secondary_route_ref}`}
      className="read-only"
    >
      <ul className="divide-y divide-[var(--border-subtle)]">
        {rows.map((row) => (
          <li key={row.target} className="flex items-start gap-3 px-4 py-2">
            <Badge tone={row.tone}>{row.target}</Badge>
            <span className="min-w-0 flex-1 pt-0.5 text-2xs leading-relaxed text-muted">
              {row.purpose}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2.5 text-2xs leading-relaxed text-subtle">
        Route-back is <strong className="text-muted">whole-channel</strong> by design: DOG, BUG and
        TICKER live on the buffer channel, and a layer-scoped route would cut them off air.
      </p>
    </Panel>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className="mt-0.5 text-xs font-medium text-default">{value}</dd>
    </div>
  )
}


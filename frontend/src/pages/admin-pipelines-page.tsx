import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { pipelinesApi, serversApi } from '@/api/playout'
import type { Pipeline, Server } from '@/api/types'
import { useAuth } from '@/hooks/use-auth'
import { usePipelines, useServers } from '@/hooks/use-playout-data'
import { ApiError, isApiError } from '@/lib/api-client'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ConfirmDialog, Modal } from '@/components/ui/modal'
import { Label } from '@/components/ui/toggle'
import {
  AgentDot,
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Spinner,
} from '@/components/ui/primitives'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { notify } from '@/stores/notification-store'

/**
 * Output channel configuration.
 *
 * The stream strings are editable here, and that is genuinely risky: they are
 * opaque to both the UI and the server. The form therefore treats them as raw
 * text with no validation beyond "not empty", and says so, rather than
 * pretending to check a format it cannot actually verify.
 */
export function AdminPipelinesPage() {
  const { can, isSuperuser } = useAuth()
  const canEdit = isSuperuser || can('plyout.change_outputpipeline')
  const client = useQueryClient()

  const serversQuery = useServers()
  const pipelinesQuery = usePipelines()
  const servers = serversQuery.data ?? []
  const pipelines = pipelinesQuery.data ?? []

  const [editing, setEditing] = useState<Pipeline | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Pipeline | null>(null)
  const [showServers, setShowServers] = useState(false)

  async function handleDelete(pipeline: Pipeline) {
    setDeleting(null)
    try {
      await pipelinesApi.remove(pipeline.id)
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      notify.success(`Deleted ${pipeline.name}`)
    } catch (error) {
      notify.error('Could not delete the channel', (error as ApiError).message)
    }
  }

  if (pipelinesQuery.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Output channels"
        description="One channel is one on-air output: a CasparCG channel pair plus a set of stream strings."
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setShowServers(true)} icon={<RefreshCw className="h-3.5 w-3.5" />}>
              Servers
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canEdit || servers.length === 0}
              onClick={() => setEditing('new')}
              icon={<Plus className="h-3.5 w-3.5" />}
            >
              New channel
            </Button>
          </>
        }
      />

      <div className="p-6">
        <Panel bodyClassName="max-h-[70vh] overflow-auto">
          {pipelines.length === 0 ? (
            <EmptyState title="No output channels" description="Create one to start scheduling." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Server</TH>
                  <TH className="w-40">Channel / buffer</TH>
                  <TH className="w-32">Layers</TH>
                  <TH className="w-24">Agent</TH>
                  <TH className="w-20 text-right">Air</TH>
                  <TH className="w-24" />
                </tr>
              </THead>
              <TBody>
                {pipelines.map((pipeline) => (
                  <TR key={pipeline.id}>
                    <TD>
                      <span className="block text-xs font-medium text-default">{pipeline.name}</span>
                      <span className="block font-mono text-[10px] text-subtle">
                        #{pipeline.id}
                      </span>
                    </TD>
                    <TD>
                      <span className="flex items-center gap-1.5 text-2xs text-muted">
                        <AgentDot state={pipeline.engine_state} />
                        {pipeline.server_name}
                      </span>
                    </TD>
                    <TD numeric>
                      <span className="tnum text-2xs text-default">
                        Ch{pipeline.primary_channel_number} ← Ch{pipeline.secondary_channel_number}
                      </span>
                    </TD>
                    <TD numeric>
                      <span className="tnum text-2xs text-muted">
                        {pipeline.primary_playout_layer} / {pipeline.primary_graphics_layer} ·{' '}
                        {pipeline.secondary_receiver_layer}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={pipeline.engine_state === 'online' ? 'ok' : pipeline.engine_state === 'stale' ? 'warn' : 'danger'}>
                        {pipeline.engine_state}
                      </Badge>
                    </TD>
                    <TD>
                      <span className="text-right">
                        {pipeline.is_on_air ? <Badge tone="danger">ON AIR</Badge> : <Badge tone="muted">standby</Badge>}
                      </span>
                    </TD>
                    <TD>
                      <span className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!canEdit}
                          aria-label={`Edit ${pipeline.name}`}
                          onClick={() => setEditing(pipeline)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!can('plyout.delete_outputpipeline')}
                          aria-label={`Delete ${pipeline.name}`}
                          onClick={() => setDeleting(pipeline)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Panel>
      </div>

      <PipelineDialog
        state={editing}
        servers={servers}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />

      <ServerDialog open={showServers} onOpenChange={setShowServers} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}`}
        description="This removes the channel and every schedule event on it. The playout agent is told to forget it. This cannot be undone."
        confirmLabel="Delete channel"
        onConfirm={() => deleting && handleDelete(deleting)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

interface FormState {
  server: string
  name: string
  primary_channel_number: string
  primary_playout_layer: string
  primary_graphics_layer: string
  secondary_channel_number: string
  secondary_receiver_layer: string
  stream_source_url: string
  output_destination_url: string
  preview_stream_url: string
  preview_embed_url: string
}

function PipelineDialog({
  state,
  servers,
  onClose,
  onSaved,
}: {
  state: Pipeline | 'new' | null
  servers: Server[]
  onClose: () => void
  onSaved: () => void
}) {
  const client = useQueryClient()
  const existing = state !== 'new' ? state : null

  const [form, setForm] = useState<FormState>(() => emptyForm(servers[0]?.id))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!state) return
    setError(null)
    setForm(existing ? toForm(existing) : emptyForm(servers[0]?.id))
  }, [state, existing, servers])

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value })),
  })

  async function submit() {
    setError(null)
    if (!form.name.trim()) return setError('Give the channel a name.')
    if (form.stream_source_url.trim() === '') return setError('A source string is required.')

    setSaving(true)
    try {
      const payload = {
        server: Number(form.server),
        name: form.name.trim(),
        primary_channel_number: Number(form.primary_channel_number),
        primary_playout_layer: Number(form.primary_playout_layer),
        primary_graphics_layer: Number(form.primary_graphics_layer),
        secondary_channel_number: Number(form.secondary_channel_number),
        secondary_receiver_layer: Number(form.secondary_receiver_layer),
        stream_source_url: form.stream_source_url,
        output_destination_url: form.output_destination_url,
        preview_stream_url: form.preview_stream_url,
        preview_embed_url: form.preview_embed_url,
      }
      if (existing) await pipelinesApi.update(existing.id, payload)
      else await pipelinesApi.create(payload)

      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      client.invalidateQueries({ queryKey: queryKeys.servers })
      notify.success(existing ? `Updated ${form.name}` : `Created ${form.name}`)
      onSaved()
    } catch (cause) {
      const apiError = cause as ApiError
      setError(isApiError(apiError) ? apiError.message : 'Could not save the channel.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      title={existing ? `Edit ${existing.name}` : 'New output channel'}
      description="Stream fields are opaque CasparCG/ffmpeg argument strings — stored and sent verbatim."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={submit}>
            {existing ? 'Save changes' : 'Create channel'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-2xs text-danger">
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <Label className="mb-1.5 block">Server</Label>
            <Select
              value={form.server}
              onValueChange={(value) => setForm((f) => ({ ...f, server: value }))}
              options={servers.map((server) => ({ value: String(server.id), label: server.name }))}
              className="w-full"
              disabled={existing !== null}
              aria-label="Server"
            />
            {existing && (
              <span className="mt-1 block text-2xs text-subtle">
                A channel cannot be moved to another server.
              </span>
            )}
          </label>

          <Input label="Name" placeholder="PIPE_1" {...field('name')} />
        </div>

        <div className="rounded-lg border border-line p-3">
          <p className="mb-3 text-2xs font-semibold tracking-wide text-muted uppercase">
            CasparCG channel map
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input label="Air channel" type="number" {...field('primary_channel_number')} />
            <Input label="Playout layer" type="number" {...field('primary_playout_layer')} />
            <Input label="Graphics layer" type="number" {...field('primary_graphics_layer')} />
            <Input label="Buffer channel" type="number" {...field('secondary_channel_number')} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input label="Source layer" type="number" {...field('secondary_receiver_layer')} />
            <div className="col-span-1 flex items-end">
              <span className="pb-2 text-2xs text-subtle">
                Consumer 99 = air out · 98 = preview
              </span>
            </div>
          </div>
        </div>

        <Textarea
          label="Source (SRT / RTMP ingest)"
          rows={2}
          {...field('stream_source_url')}
          hint="e.g. srt://host:port?mode=caller&transtype=live"
        />
        <Textarea
          label="Destination (air output)"
          rows={3}
          {...field('output_destination_url')}
          hint="Full ffmpeg argument string, including quotes and flags."
        />
        <Textarea
          label="Preview output"
          rows={3}
          {...field('preview_stream_url')}
          hint="Low-resolution monitor feed."
        />
        <Input
          label="Preview embed URL"
          placeholder="https://… (optional operator preview player)"
          {...field('preview_embed_url')}
        />
      </div>
    </Modal>
  )
}

function ServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const serversQuery = useServers()
  const servers = serversQuery.data ?? []

  const [token, setToken] = useState<{ server: string; value: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function issue(serverId: number) {
    setBusy(true)
    try {
      const result = await serversApi.issueEngineToken(serverId)
      setToken({ server: result.server, value: result.token })
      client.invalidateQueries({ queryKey: queryKeys.servers })
    } catch (error) {
      notify.error('Could not issue a token', (error as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  const rows = useMemo(() => servers, [servers])

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Servers" size="lg">
      <div className="space-y-4">
        <Table>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Address</TH>
              <TH>Agent</TH>
              <TH className="w-32" />
            </tr>
          </THead>
          <TBody>
            {rows.map((server) => (
              <TR key={server.id}>
                <TD>
                  <span className="text-xs font-medium text-default">{server.name}</span>
                  <span className="flex items-center gap-1 text-2xs text-muted">
                    <Badge tone={server.is_active ? 'ok' : 'muted'}>
                      {server.is_active ? 'active' : 'inactive'}
                    </Badge>
                  </span>
                </TD>
                <TD>
                  <span className="font-mono text-2xs text-default">
                    {server.ip_address}:{server.amcp_port}
                  </span>
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
                    <AgentDot state={server.agent_state} />
                    {server.agent_state}
                  </span>
                </TD>
                <TD>
                  <span className="flex justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => issue(server.id)}
                      icon={<KeyRound className="h-3.5 w-3.5" />}
                    >
                      Engine token
                    </Button>
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        {token && (
          <div className="rounded-lg border border-warn bg-warn-soft p-3">
            <p className="text-xs font-medium text-default">Engine token for {token.server}</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Shown once and never recoverable. Copy it now and put it in the agent&apos;s
              configuration.
            </p>
            <code className="mt-2 block break-all rounded border border-line bg-inset px-2 py-1.5 font-mono text-2xs text-default">
              {token.value}
            </code>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

function emptyForm(serverId?: number): FormState {
  return {
    server: String(serverId ?? ''),
    name: '',
    primary_channel_number: '1',
    primary_playout_layer: '21',
    primary_graphics_layer: '20',
    secondary_channel_number: '2',
    secondary_receiver_layer: '1',
    stream_source_url: '',
    output_destination_url: '',
    preview_stream_url: '',
    preview_embed_url: '',
  }
}

function toForm(pipeline: Pipeline): FormState {
  return {
    server: String(pipeline.server),
    name: pipeline.name,
    primary_channel_number: String(pipeline.primary_channel_number),
    primary_playout_layer: String(pipeline.primary_playout_layer),
    primary_graphics_layer: String(pipeline.primary_graphics_layer),
    secondary_channel_number: String(pipeline.secondary_channel_number),
    secondary_receiver_layer: String(pipeline.secondary_receiver_layer),
    stream_source_url: pipeline.stream_source_url,
    output_destination_url: pipeline.output_destination_url,
    preview_stream_url: pipeline.preview_stream_url,
    preview_embed_url: pipeline.preview_embed_url,
  }
}


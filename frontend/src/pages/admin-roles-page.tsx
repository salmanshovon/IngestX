import { useEffect, useMemo, useState } from 'react'
import { Lock, Pencil, Plus, Shield, Trash2, Users } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { rolesApi } from '@/api/accounts'
import type { Role, RolePermissionsMatrix } from '@/api/types'
import { useAuth } from '@/hooks/use-auth'
import { ApiError } from '@/lib/api-client'
import { queryKeys } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog, Modal } from '@/components/ui/modal'
import { Checkbox, Label } from '@/components/ui/toggle'
import { Badge, PageHeader, Panel, Spinner } from '@/components/ui/primitives'
import { notify } from '@/stores/notification-store'

/**
 * Role and permission administration (WF-05).
 *
 * The Role -> Group -> Permission triple is synchronised server-side by three
 * signals. Assigning a permission here therefore changes what `has_perm()`
 * returns everywhere in the API, immediately — which is why the matrix is
 * shown grouped by app rather than as one flat list of ~80 checkboxes.
 */
export function AdminRolesPage() {
  const { can, isSuperuser } = useAuth()
  const client = useQueryClient()

  const matrixQuery = useQuery({ queryKey: queryKeys.roleMatrix, queryFn: () => rolesApi.matrix() })
  const rolesQuery = useQuery({ queryKey: queryKeys.roles, queryFn: () => rolesApi.list() })

  const [editing, setEditing] = useState<Role | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Role | null>(null)

  const canEdit = isSuperuser || can('accounts.change_role')
  const canCreate = isSuperuser || can('accounts.add_role')
  const canDelete = isSuperuser || can('accounts.delete_role')

  const permissions = matrixQuery.data?.permissions ?? []
  const grouped = useMemo(() => {
    const map = new Map<string, typeof permissions>()
    for (const permission of permissions) {
      const list = map.get(permission.app_label) ?? []
      list.push(permission)
      map.set(permission.app_label, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [permissions])

  async function remove(role: Role) {
    setDeleting(null)
    try {
      await rolesApi.remove(role.id)
      client.invalidateQueries({ queryKey: queryKeys.roles })
      client.invalidateQueries({ queryKey: queryKeys.roleMatrix })
      notify.success(`Deleted role ${role.name}`)
    } catch (error) {
      const apiError = error as ApiError
      if (apiError.code === 'ROLE_IN_USE') {
        notify.warning(
          `${apiError.body.user_count ?? 'Some'} user(s) still hold this role`,
          'Reassign them to another role before deleting it.',
        )
        return
      }
      if (apiError.code === 'PROTECTED_ROLE') {
        notify.warning('That role is protected', 'The admin and superuser roles cannot be deleted.')
        return
      }
      notify.error('Could not delete the role', apiError.message)
    }
  }

  if (matrixQuery.isLoading || rolesQuery.isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Roles & permissions"
        description="Permissions are enforced server-side on every browser endpoint."
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!canCreate}
            onClick={() => setEditing('new')}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            New role
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <Panel title="Roles" bodyClassName="max-h-[70vh] overflow-auto">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {(rolesQuery.data ?? []).map((role) => (
              <li key={role.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sunken text-subtle">
                  {role.is_protected ? <Lock className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-default">{role.name}</span>
                    {role.is_protected && <Badge tone="warn">protected</Badge>}
                  </span>
                  <span className="block truncate text-2xs text-subtle">
                    {role.description || 'No description'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="muted" icon={<Users className="h-3 w-3" />}>
                    {role.user_count}
                  </Badge>
                  <span className="tnum text-2xs text-subtle">{role.permissions.length} perms</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={!canEdit}
                    aria-label={`Edit ${role.name}`}
                    onClick={() => setEditing(role)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={!canDelete || role.is_protected}
                    aria-label={`Delete ${role.name}`}
                    onClick={() => setDeleting(role)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-danger" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Permission matrix"
          description={`${permissions.length} permissions across ${grouped.length} apps`}
          bodyClassName="max-h-[70vh] overflow-auto p-4"
        >
          <div className="space-y-4">
            {grouped.map(([appLabel, list]) => (
              <div key={appLabel}>
                <p className="mb-2 text-2xs font-semibold tracking-wide text-muted uppercase">
                  {appLabel}
                </p>
                <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
                  {list.map((permission) => {
                    const role = (matrixQuery.data as RolePermissionsMatrix).roles.find((entry) =>
                      entry.permissions.includes(permission.id),
                    )
                    return (
                      <div
                        key={permission.id}
                        className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5"
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            role ? 'bg-ok' : 'bg-subtle',
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-2xs text-default">{permission.name}</span>
                          <span className="block truncate font-mono text-[10px] text-subtle">
                            {permission.codename}
                          </span>
                        </span>
                        {role && (
                          <Badge tone="muted" className="shrink-0">
                            {role.name}
                          </Badge>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <RoleDialog
        state={editing}
        permissions={permissions}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete role ${deleting?.name ?? ''}`}
        description="Roles that still have users are refused unless they are reassigned first."
        confirmLabel="Delete role"
        onConfirm={() => deleting && remove(deleting)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function RoleDialog({
  state,
  permissions,
  onClose,
}: {
  state: Role | 'new' | null
  permissions: RolePermissionsMatrix['permissions']
  onClose: () => void
}) {
  const client = useQueryClient()
  const existing = state !== 'new' ? state : null

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!state) return
    setError(null)
    setName(existing?.name ?? '')
    setDescription(existing?.description ?? '')
    setSelected(new Set(existing?.permissions ?? []))
  }, [state, existing])

  const grouped = useMemo(() => {
    const map = new Map<string, typeof permissions>()
    for (const permission of permissions) {
      const list = map.get(permission.app_label) ?? []
      list.push(permission)
      map.set(permission.app_label, list)
    }
    return Array.from(map.entries())
  }, [permissions])

  const save = useMutation({
    mutationFn: () =>
      existing
        ? rolesApi.update(existing.id, {
            name: name.trim(),
            description,
            permissions: Array.from(selected),
          })
        : rolesApi.create({ name: name.trim(), description, permissions: Array.from(selected) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.roles })
      client.invalidateQueries({ queryKey: queryKeys.roleMatrix })
      notify.success(existing ? 'Role updated' : 'Role created')
    },
  })

  return (
    <Modal
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      title={existing ? `Edit ${existing.name}` : 'New role'}
      description="Permissions are mirrored onto the matching auth Group, which is what the API checks."
      size="lg"
      footer={
        <>
          <span className="mr-auto tnum text-2xs text-muted">
            {selected.size} permission{selected.size === 1 ? '' : 's'} selected
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            onClick={() => {
              setError(null)
              if (!name.trim()) return setError('Give the role a name.')
              save.mutate()
            }}
          >
            {existing ? 'Save changes' : 'Create role'}
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
          <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>

        <div className="max-h-80 space-y-3 overflow-auto rounded-lg border border-line p-3">
          {grouped.map(([appLabel, list]) => (
            <div key={appLabel}>
              <div className="mb-1.5 flex items-center justify-between">
                <Label>{appLabel}</Label>
                <button
                  type="button"
                  className="text-2xs font-medium text-accent hover:underline"
                  onClick={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      const allOn = list.every((permission) => next.has(permission.id))
                      for (const permission of list) {
                        if (allOn) next.delete(permission.id)
                        else next.add(permission.id)
                      }
                      return next
                    })
                  }
                >
                  Toggle all
                </button>
              </div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {list.map((permission) => (
                  <label
                    key={permission.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-2xs text-muted hover:bg-hover"
                  >
                    <Checkbox
                      checked={selected.has(permission.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (checked) next.add(permission.id)
                          else next.delete(permission.id)
                          return next
                        })
                      }
                    />
                    <span className="min-w-0 truncate">{permission.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}


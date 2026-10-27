import { useEffect, useState } from 'react'
import { Check, Mail, Pencil, Plus, Search, ShieldCheck, UserCheck, UserX } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { usersApi, rolesApi, departmentsApi } from '@/api/accounts'
import type { AccountUser, Department } from '@/api/types'
import { useAuth } from '@/hooks/use-auth'
import { ApiError, isApiError } from '@/lib/api-client'
import { queryKeys } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ConfirmDialog, Modal } from '@/components/ui/modal'
import { Checkbox, Label } from '@/components/ui/toggle'
import {
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Spinner,
} from '@/components/ui/primitives'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { notify } from '@/stores/notification-store'

/**
 * User administration.
 *
 * Two constraints from the backend are surfaced rather than worked around:
 *
 * - A created user's password is a **6-digit temporary password sent by email**
 *   and is never returned by the API (AC-11). So this screen cannot show it,
 *   and must not pretend to.
 * - Superusers cannot be deleted or deactivated, and neither can you yourself.
 *   The controls are disabled rather than hidden, so the reason is discoverable.
 */
export function AdminUsersPage() {
  const { can, isSuperuser, session } = useAuth()
  const client = useQueryClient()

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => setPage(1), [debounced])

  const usersQuery = useQuery({
    queryKey: queryKeys.users({ search: debounced, page }),
    queryFn: () => usersApi.list({ search: debounced || undefined, page, page_size: 25 }),
  })

  const rolesQuery = useQuery({ queryKey: queryKeys.roles, queryFn: () => rolesApi.list() })
  const departmentsQuery = useQuery({ queryKey: queryKeys.departments, queryFn: () => departmentsApi.list() })

  const [editing, setEditing] = useState<AccountUser | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccountUser | null>(null)

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      active ? usersApi.activate(id) : usersApi.deactivate(id),
    onSuccess: (user) => {
      client.invalidateQueries({ queryKey: ['users'] })
      notify.success(`${user.username} ${user.is_active ? 'activated' : 'deactivated'}`)
    },
    onError: (error) => {
      const apiError = error as ApiError
      notify.error(
        'Could not change the account',
        apiError.message,
      )
    },
  })

  const removeUser = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['users'] })
      notify.success('User deleted')
    },
    onError: (error) => notify.error('Could not delete the user', (error as ApiError).message),
  })

  const users = usersQuery.data?.results ?? []
  const total = usersQuery.data?.count ?? 0
  const pageSize = usersQuery.data?.page_size ?? 25
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const canCreate = isSuperuser || can('accounts.add_user')
  const canEdit = isSuperuser || can('accounts.change_user')
  const canDelete = isSuperuser || can('accounts.delete_user')

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Users"
        description={`${total} account${total === 1 ? '' : 's'} · sign-in uses the username, never the email address`}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!canCreate}
            onClick={() => setEditing('new')}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            New user
          </Button>
        }
      />

      <div className="space-y-4 p-6">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by username, name or email…"
          leading={<Search className="h-3.5 w-3.5" />}
          className="max-w-md"
          aria-label="Search users"
        />

        <Panel bodyClassName="max-h-[60vh] overflow-auto">
          {usersQuery.isLoading ? (
            <div className="flex justify-center py-14"><Spinner /></div>
          ) : users.length === 0 ? (
            <EmptyState
              title={debounced ? 'No users matched' : 'No user accounts'}
              description={
                debounced
                  ? 'Try a different search term.'
                  : // The backend deliberately hides superusers and cadets from
                    // this list (BR-USR-01). If that is the only account, an
                    // empty table is correct — say so rather than look broken.
                    'Superuser accounts are not listed here by design. Create an operator account below, or use the Django admin for superusers.'
              }
              action={
                !debounced && canCreate ? (
                  <Button size="sm" variant="primary" onClick={() => setEditing('new')} icon={<Plus className="h-3.5 w-3.5" />}>
                    Create the first account
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Username</TH>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Roles</TH>
                  <TH className="w-32">Department</TH>
                  <TH className="w-24">State</TH>
                  <TH className="w-32" />
                </tr>
              </THead>
              <TBody>
                {users.map((user) => {
                  const isSelf = user.id === session?.user.id
                  const protectedUser = user.is_superuser || isSelf
                  return (
                    <TR key={user.id}>
                      <TD>
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-default">{user.username}</span>
                          {user.is_superuser && (
                            <Badge tone="warn" icon={<ShieldCheck className="h-3 w-3" />}>superuser</Badge>
                          )}
                          {user.is_new && <Badge tone="info">must reset</Badge>}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-2xs text-default">
                          {[user.first_name, user.last_name].filter(Boolean).join(' ') || '—'}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-2xs text-muted">{user.email}</span>
                      </TD>
                      <TD>
                        <span className="flex flex-wrap gap-1">
                          {user.roles.length === 0 ? (
                            <span className="text-2xs text-subtle">none</span>
                          ) : (
                            user.roles.map((role) => (
                              <Badge key={role.id} tone="accent">{role.name}</Badge>
                            ))
                          )}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-2xs text-muted">{user.department_name ?? '—'}</span>
                      </TD>
                      <TD>
                        <Badge tone={user.is_active ? 'ok' : 'muted'}>
                          {user.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TD>
                      <TD>
                        <span className="flex justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={!canEdit || protectedUser}
                            aria-label={user.is_active ? `Deactivate ${user.username}` : `Activate ${user.username}`}
                            title={
                              protectedUser
                                ? user.is_superuser
                                  ? 'Superusers cannot be deactivated'
                                  : 'You cannot change your own state'
                                : undefined
                            }
                            onClick={() => toggleActive.mutate({ id: user.id, active: !user.is_active })}
                          >
                            {user.is_active ? (
                              <UserX className="h-3.5 w-3.5" />
                            ) : (
                              <UserCheck className="h-3.5 w-3.5 text-ok" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={!canEdit}
                            aria-label={`Edit ${user.username}`}
                            onClick={() => setEditing(user)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={!canDelete || protectedUser}
                            aria-label={`Delete ${user.username}`}
                            title={protectedUser ? 'This account is protected' : undefined}
                            onClick={() => setDeleting(user)}
                          >
                            <Trash2Icon />
                          </Button>
                        </span>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </Panel>

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-3 text-2xs text-muted">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="tnum">
              Page {page} of {pageCount}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>

      <UserDialog
        state={editing}
        roles={rolesQuery.data ?? []}
        departments={departmentsQuery.data ?? []}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.username ?? ''}`}
        description="This permanently removes the account and its role assignments."
        confirmLabel="Delete user"
        loading={removeUser.isPending}
        onConfirm={() => {
          if (!deleting) return
          removeUser.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }}
      />
    </div>
  )
}

function Trash2Icon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-danger" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------

function UserDialog({
  state,
  roles,
  departments,
  onClose,
}: {
  state: AccountUser | 'new' | null
  roles: Array<{ id: number; name: string }>
  departments: Department[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const existing = state !== 'new' ? state : null
  const isNew = existing === null

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [roleIds, setRoleIds] = useState<number[]>([])
  const [availability, setAvailability] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!state) return
    setError(null)
    setAvailability(null)
    setUsername(existing?.username ?? '')
    setEmail(existing?.email ?? '')
    setFirstName(existing?.first_name ?? '')
    setLastName(existing?.last_name ?? '')
    setPhone(existing?.phone_number ?? '')
    setAddress(existing?.address ?? '')
    setDepartmentId(existing?.department ? String(existing.department) : '')
    setRoleIds(existing?.role_ids ?? [])
  }, [state, existing])

  // FR-FRM-04: availability is checked asynchronously, debounced.
  useEffect(() => {
    if (!isNew || username.trim().length < 2) {
      setAvailability(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const result = await usersApi.usernameAvailable(username.trim())
        if (!cancelled) setAvailability(result.is_available)
      } catch {
        if (!cancelled) setAvailability(null)
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [username, isNew])

  const createUser = useMutation({
    mutationFn: () =>
      usersApi.create({
        username: username.trim(),
        email: email.trim(),
        first_name: firstName,
        last_name: lastName,
        phone_number: phone,
        address,
        department_id: departmentId ? Number(departmentId) : null,
        roles: roleIds,
      }),
    onSuccess: (result) => {
      notify.success(
        `Created ${result.username}`,
        'A temporary password has been emailed. The user must change it at first sign-in.',
      )
    },
  })

  const updateUser = useMutation({
    mutationFn: () =>
      usersApi.update(existing!.id, {
        email: email.trim(),
        first_name: firstName,
        last_name: lastName,
        phone_number: phone,
        address,
        department_id: departmentId ? Number(departmentId) : null,
        roles: roleIds,
      }),
    onSuccess: () => notify.success('User updated'),
  })

  async function submit() {
    setError(null)
    if (!email.trim()) return setError('An email address is required — it is how the user receives their temporary password.')
    if (isNew) {
      if (!username.trim()) return setError('A username is required.')
      if (availability === false) return setError('That username is already taken.')
    }
    setSaving(true)
    try {
      if (isNew) await createUser.mutateAsync()
      else await updateUser.mutateAsync()
      client.invalidateQueries({ queryKey: ['users'] })
      onClose()
    } catch (cause) {
      const apiError = cause as ApiError
      if (isApiError(apiError)) {
        const fields = apiError.fieldErrors()
        setError(
          Object.keys(fields).length > 0
            ? Object.entries(fields).map(([field, message]) => `${field}: ${message}`).join(' · ')
            : apiError.message,
        )
      } else {
        setError('Could not save the user.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? 'New user' : `Edit ${existing?.username}`}
      description={isNew ? 'The account signs in with its username and starts with a temporary password.' : undefined}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={submit}>
            {isNew ? 'Create user' : 'Save changes'}
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
          <div>
            <Input
              label="Username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={!isNew}
              autoCapitalize="none"
              spellCheck={false}
              leading={<Check size={12} className={cn(isNew && 'opacity-0')} />}
            />
            {isNew && availability !== null && (
              <p className={cn('mt-1 text-2xs', availability ? 'text-ok' : 'text-danger')}>
                {availability ? 'Available' : 'Already taken'}
              </p>
            )}
          </div>

          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            leading={<Mail className="h-3.5 w-3.5" />}
          />

          <Input label="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          <Input label="Last name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          <Input label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <label className="block">
            <Label className="mb-1.5 block">Department</Label>
            <Select
              value={departmentId}
              onValueChange={setDepartmentId}
              options={[
                { value: '', label: 'No department' },
                ...departments.map((department) => ({ value: String(department.id), label: department.name })),
              ]}
              className="w-full"
            />
          </label>
        </div>

        <Textarea label="Address" rows={2} value={address} onChange={(event) => setAddress(event.target.value)} />

        <div>
          <Label className="mb-2 block">Roles</Label>
          {roles.length === 0 ? (
            <p className="text-2xs text-subtle">No roles are defined yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {roles.map((role) => (
                <label key={role.id} className="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                  <Checkbox
                    checked={roleIds.includes(role.id)}
                    onCheckedChange={(checked) =>
                      setRoleIds((current) =>
                        checked ? [...current, role.id] : current.filter((id) => id !== role.id),
                      )
                    }
                  />
                  {role.name}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}


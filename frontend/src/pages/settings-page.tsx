import { useEffect, useState } from 'react'

import { api } from '@/lib/api-client'
import { PageHeader } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/format'

export function SettingsPage() {
  const [minutes, setMinutes] = useState(30)
  const [loading, setLoading] = useState(true)
  const queryClient = useQueryClient()

  useEffect(() => {
    api.get<{ default_duration_minutes: number }>('/record-settings').then((data) => {
      setMinutes(data.default_duration_minutes)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  async function save() {
    await api.patch('/record-settings', { default_duration_minutes: minutes })
    queryClient.invalidateQueries({ queryKey: queryKeys.recordSettings })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Settings" description="Recording defaults." />
      <div className="p-6 max-w-md space-y-4">
        <label className="text-sm text-default">Default record duration (minutes)</label>
        <Input
          type="number"
          value={String(minutes)}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
        <Button onClick={save} disabled={loading}>Save</Button>
      </div>
    </div>
  )
}

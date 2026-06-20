import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card'
import { SettingRow } from '@/components/setting-row'
import type { FeatureSetting } from '@/lib/api'

interface SettingsSectionProps {
  title: string
  settings: FeatureSetting[]
  localValues: Record<string, boolean | number>
  onChange: (key: string, value: boolean | number) => void
}

export function SettingsSection({ title, settings, localValues, onChange }: SettingsSectionProps) {
  /** Resolve a setting's current effective value (local override → server value). */
  function getValue(key: string): boolean | number {
    if (key in localValues) return localValues[key]
    const s = settings.find((s) => s.key === key)
    return s?.value ?? false
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {settings.map((setting) => {
            const disabled =
              setting.parentToggle !== undefined && !getValue(setting.parentToggle)
            return (
              <SettingRow
                key={setting.key}
                setting={setting}
                value={getValue(setting.key)}
                onChange={(v) => onChange(setting.key, v)}
                disabled={disabled}
              />
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

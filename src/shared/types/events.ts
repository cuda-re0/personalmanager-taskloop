import type {
  DayStat,
  Message,
  NotifyChannel,
  Occurrence,
  PointEntry,
  ReminderLevel,
  Task
} from './domain'
import type { HudMode } from './ipc'

export type DomainEvent =
  | { type: 'task.created'; task: Task }
  | { type: 'task.updated'; task: Task; changed: (keyof Task)[] }
  | { type: 'task.removed'; taskId: string }
  | { type: 'occurrence.created'; occurrences: Occurrence[] }
  | { type: 'occurrence.updated'; occurrence: Occurrence }
  | { type: 'message.appended'; message: Message }
  | { type: 'message.patch'; messageId: string; patch: Partial<Message> }
  | { type: 'ai.status'; phase: 'thinking' | 'streaming' | 'idle'; messageId?: string }
  | { type: 'points.changed'; balance: number; entry: PointEntry | null; today: DayStat }
  | {
      type: 'reminder.fired'
      reminderId: string
      taskId: string | null
      title: string
      level: ReminderLevel
    }
  | { type: 'reminder.failed'; reminderId: string; channel: NotifyChannel; reason: string }
  | { type: 'daystats.changed'; day: DayStat }
  | { type: 'app.setting.changed'; key: string; value: unknown }
  | { type: 'channel.status'; channels: { id: NotifyChannel; available: boolean }[] }
  | { type: 'hud.mode.changed'; mode: HudMode }
  | { type: 'hud.visible.changed'; visible: boolean }

export type DomainEventType = DomainEvent['type']

export interface Task { id: number | string; title: string; description?: string | null; completed: boolean; due_date: string | null; created_at?: string; source?: 'local' | 'google' }
export interface TaskList { tasks: Task[]; total: number; completed: number }
export interface User { id: number; email: string }

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  account?: { email: string | null };
  state?: 'active' | 'needs_reauth';
  range?: { start: string; end: string };
  lastSyncAt?: string | null;
  lastSyncStatus?: 'ok' | 'partial' | 'error' | null;
  lastError?: string | null;
  syncing?: boolean;
  selectedCalendars?: number;
  stale?: boolean;
}
export interface GoogleCalendar { id: string; summary: string; color: string | null; selected: boolean; importedTasks: number; lastError?: string | null }
export interface SyncResult { status: 'ok' | 'partial' | 'error' | 'skipped'; created?: number; updated?: number; deleted?: number; message?: string | null; reason?: string; queried?: number }

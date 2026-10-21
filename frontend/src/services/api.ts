import type { GoogleCalendar, GoogleStatus, SyncResult, Task, TaskList, User } from '../types';
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public extra: Record<string, unknown> = {}) { super(message); }
}

// Chamado quando o servidor responde 401 (sessão ausente/expirada) em qualquer rota.
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn; };

// A sessão vive num cookie httpOnly (o JavaScript nunca vê o token). O cabeçalho X-Requested-With é a
// proteção CSRF exigida pelo servidor em requisições que alteram estado. Nada é guardado em localStorage.
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'todolist', ...(init?.headers ?? {}) } });
  } catch { throw new ApiError('Não foi possível falar com o servidor. Verifique sua conexão.', 0, 'NETWORK'); }
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401 && (body as any)?.code === 'UNAUTHENTICATED') onUnauthorized?.();
    throw new ApiError((body as any)?.message || `Erro ${res.status} ao falar com o servidor`, res.status, (body as any)?.code, (body as any) ?? {});
  }
  return body as T;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------- autenticação ----------
export const me = () => req<User>('/api/auth/me');
export const login = (email: string, password: string) => req<User>('/api/auth/login', json('POST', { email, password }));
export const register = (email: string, password: string) => req<User>('/api/auth/register', json('POST', { email, password }));
export const logout = () => req<void>('/api/auth/logout', json('POST', {}));

// ---------- tarefas (rotas locais; nenhuma delas toca o Google Calendar) ----------
const norm = (t: any): Task => ({ ...t, completed: Boolean(t.completed), due_date: t.due_date ? String(t.due_date).slice(0, 10) : null });
export const loadTasks = async (search = ''): Promise<TaskList> => {
  const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  const r = await req<TaskList>(`/api/tasks${q}`);
  return { ...r, tasks: (r.tasks ?? []).map(norm) };
};
const unwrap = (r: any) => norm(r?.task ?? r);
export const createTask = async (title: string, dueDate: string | null) =>
  unwrap(await req('/api/tasks', json('POST', dueDate ? { title, dueDate } : { title })));
export const updateTask = async (id: Task['id'], patch: { title?: string; dueDate?: string | null; completed?: boolean }) =>
  unwrap(await req(`/api/tasks/${id}`, json('PATCH', patch)));
export const deleteTask = (id: Task['id']) => req<void>(`/api/tasks/${id}`, { method: 'DELETE' });

// ---------- Google Calendar (somente leitura: o servidor nunca escreve no calendário) ----------
const G = '/api/integrations/google';
export type Choice = 'remove' | 'keep';
export const googleStatus = () => req<GoogleStatus>(`${G}/status`);
export const googleConnect = () => req<{ url: string }>(`${G}/connect`, json('POST', {}));
export const googleCalendars = (refresh = false) => req<{ calendars: GoogleCalendar[] }>(`${G}/calendars${refresh ? '?refresh=1' : ''}`).then(r => r.calendars);
export const googleSaveCalendars = (selected: string[], onDeselect?: Choice) => req<{ sync: SyncResult | null; deselected: number }>(`${G}/calendars`, json('PUT', { selected, onDeselect }));
export const googleSaveRange = (rangeStart: string, rangeEnd: string, outside?: Choice) => req<{ outsideTasks: number; sync: SyncResult | null }>(`${G}/settings`, json('PUT', { rangeStart, rangeEnd, outside }));
export const googleSync = () => req<SyncResult>(`${G}/sync`, json('POST', {}));
export const googleSyncWeeks = (weeks: string[], force = false) => req<SyncResult>(`${G}/sync/weeks`, json('POST', { weeks, force }));
export const googleDisconnect = (tasks: Choice) => req<{ disconnected: boolean; tokenRevoked: boolean }>(`${G}/disconnect`, json('POST', { tasks }));

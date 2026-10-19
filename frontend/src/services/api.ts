import type { Task, TaskList } from '../types';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Requisições sem corpo (como DELETE) não devem anunciar JSON sem enviar um corpo.
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) throw new Error(`Erro ${res.status} ao falar com o servidor`);
  return res.status === 204 ? (undefined as T) : res.json().catch(() => undefined as T);
}

const norm = (t: any): Task => ({
  ...t,
  completed: Boolean(t.completed),
  due_date: t.due_date ? String(t.due_date).slice(0, 10) : null,
});

export const loadTasks = async (search = ''): Promise<TaskList> => {
  const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  const r = await req<TaskList>(`/api/tasks${q}`);
  return { ...r, tasks: (r.tasks ?? []).map(norm) };
};

const unwrap = (r: any) => norm(r?.task ?? r);

export const createTask = async (title: string, dueDate: string | null, description = '') => {
  const cleanDescription = description.trim();
  const payload: { title: string; dueDate?: string; description: string } = {
    title,
    description: cleanDescription,
  };
  if (dueDate) payload.dueDate = dueDate;

  // Envia a descrição no cadastro para compatibilidade com APIs que já a aceitem.
  // O backend atual ignora esse campo no POST; o PATCH existente a persiste sem alterar o backend.
  const created = unwrap(await req('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  }));

  if (!cleanDescription) return created;

  return unwrap(await req(`/api/tasks/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ description: cleanDescription, dueDate }),
  }));
};

export const updateTask = async (
  id: Task['id'],
  patch: { title?: string; dueDate?: string | null; completed?: boolean; description?: string | null },
) => unwrap(await req(`/api/tasks/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
}));

export const deleteTask = (id: Task['id']) =>
  req<void>(`/api/tasks/${id}`, { method: 'DELETE' });

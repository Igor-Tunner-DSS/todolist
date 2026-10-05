export interface Task { id: number | string; title: string; description?: string | null; completed: boolean; due_date: string | null; created_at?: string }
export interface TaskList { tasks: Task[]; total: number; completed: number }

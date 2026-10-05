import { useState } from 'react';
import Modal from './Modal';
import type { Task } from '../types';
import { CalendarIcon } from './Icons';
interface P { task?: Task; defaultDate?: string | null; onClose(): void; onSubmit(title: string, due: string | null): Promise<void> }
export default function TaskModal({ task, defaultDate, onClose, onSubmit }: P) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [due, setDue] = useState(task ? task.due_date ?? '' : defaultDate ?? '');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setErr('Informe um título para a tarefa.');
    setBusy(true); setErr('');
    try { await onSubmit(title.trim(), due || null); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Modal title={task ? 'Edit Task' : 'Create Task'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <label htmlFor="f-title">Título</label>
        <input id="f-title" value={title} onChange={e => { setTitle(e.target.value); setErr(''); }} aria-invalid={!!err && !title.trim()} aria-describedby="f-err" className={err && !title.trim() ? 'invalid' : ''} placeholder="O que precisa ser feito?" autoComplete="off" />
        <label htmlFor="f-due"><CalendarIcon /> Data (opcional)</label>
        <div className="row"><input id="f-due" type="date" value={due} onChange={e => setDue(e.target.value)} />{due && <button type="button" className="ghost" onClick={() => setDue('')}>Remover data</button>}</div>
        <p id="f-err" className="err" role="alert">{err}</p>
        <footer><button type="button" className="ghost" onClick={onClose}>Cancelar</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : task ? 'Salvar' : 'Criar'}</button></footer>
      </form>
    </Modal>
  );
}

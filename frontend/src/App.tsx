import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from './types';
import * as api from './services/api';
import { useDebounce } from './hooks/useDebounce';
import { useTheme } from './hooks/useTheme';
import { daysIn, iso, mondayIndex, monthTitle, todayISO, weekday } from './utils/dates';
import { seasonOf } from './utils/season';
import { ChevronLeft, ChevronRight, InboxIcon, MoonIcon, PlusIcon, SearchIcon, SeasonIcon, SunIcon } from './components/Icons';
import TaskItem from './components/TaskItem';
import TaskModal from './components/TaskModal';
import Modal from './components/Modal';

const byDate = (a: Task, b: Task) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

export default function App() {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 300);
  const [modal, setModal] = useState<null | { task?: Task; date?: string | null }>(null);
  const [del, setDel] = useState<Task | null>(null);
  const [sel, setSel] = useState<Task['id'] | null>(null);
  const { theme, toggle } = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);
  const fail = (e: unknown) => { setToast((e as Error).message || 'Algo deu errado.'); setTimeout(() => setToast(''), 4000); };

  const load = useCallback(async () => {
    setLoading(true);
    try { setTasks((await api.loadTasks(q)).tasks); } catch (e) { fail(e); } finally { setLoading(false); }
  }, [q]);
  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => [...tasks].sort(byDate), [tasks]);
  const total = tasks.length, completed = tasks.filter(t => t.completed).length;
  const replace = (t: Task) => setTasks(p => p.map(x => (x.id === t.id ? { ...x, ...t } : x)));
  const toggleTask = async (t: Task) => { try { replace(await api.updateTask(t.id, { completed: !t.completed })); } catch (e) { fail(e); } };
  const save = async (title: string, due: string | null) => {
    if (modal?.task) replace(await api.updateTask(modal.task.id, { title, dueDate: due }));
    else { const t = await api.createTask(title, due); setTasks(p => [...p, t]); }
    setModal(null);
  };
  const confirmDel = async () => { if (!del) return; try { await api.deleteTask(del.id); setTasks(p => p.filter(x => x.id !== del.id)); } catch (e) { fail(e); } setDel(null); };

  // atalhos: n novo, / busca, j/k navegar, x concluir, e editar, d excluir
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (modal || del || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(el.tagName)) return;
      const ids = [...document.querySelectorAll<HTMLElement>('[data-task-id]')];
      const cur = ids.findIndex(n => n.dataset.taskId === String(sel));
      const task = sorted.find(t => t.id === sel);
      if (e.key === 'n') { e.preventDefault(); setModal({ date: null }); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'j' || e.key === 'k') ids[Math.max(0, Math.min(ids.length - 1, cur + (e.key === 'j' ? 1 : -1)))]?.focus();
      else if (task && e.key === 'x') toggleTask(task);
      else if (task && e.key === 'e') setModal({ task });
      else if (task && (e.key === 'd' || e.key === 'Delete')) setDel(task);
    };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  });

  const { y, m } = ym;
  const go = (d: number) => setYm(({ y, m }) => { const n = new Date(y, m + d, 1); return { y: n.getFullYear(), m: n.getMonth() }; });
  const today = todayISO();
  const days = Array.from({ length: daysIn(y, m) }, (_, i) => i + 1);
  const someday = sorted.filter(t => !t.due_date);
  const item = (t: Task, showDate = false) => <TaskItem key={t.id} task={t} showDate={showDate} selected={sel === t.id} onSelect={() => setSel(t.id)} onToggle={toggleTask} onEdit={t => setModal({ task: t })} onDelete={setDel} />;

  return (
    <div className="app">
      <header className="top">
        <div><h1>{monthTitle(y, m)}<span className="season"><SeasonIcon season={seasonOf(m)} /></span></h1>
          <p className="counts" aria-live="polite"><strong>{total}</strong> tarefas · <strong>{completed}</strong> concluídas</p></div>
        <div className="controls">
          <label className="search"><SearchIcon /><span className="sr">Buscar tarefas</span><input ref={searchRef} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar" /></label>
          <button type="button" className="icon round" aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'} onClick={toggle}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button type="button" className="icon round dark" aria-label="Mês anterior" onClick={() => go(-1)}><ChevronLeft /></button>
          <button type="button" className="icon round dark" aria-label="Próximo mês" onClick={() => go(1)}><ChevronRight /></button>
        </div>
      </header>

      <main>
        {!loading && sorted.every(t => t.completed) && <div className="empty"><InboxIcon /><p>Você não tem tarefas pendentes.</p></div>}
        <section className="grid" aria-label="Calendário" aria-busy={loading}>
          {Array.from({ length: mondayIndex(y, m, 1) }, (_, i) => <div key={`p${i}`} className="pad" aria-hidden="true" />)}
          {days.map(d => {
            const key = iso(y, m, d);
            return (
              <article key={d} className={`day${key === today ? ' today' : ''}`}>
                <h3><span>{d} {new Date(y, m).toLocaleDateString('en-US', { month: 'short' })}</span><span className="wd">{weekday(y, m, d)}</span></h3>
                <ul>{sorted.filter(t => t.due_date === key).map(t => item(t))}</ul>
                <button type="button" className="fill" aria-label={`Adicionar tarefa em ${key}`} onClick={() => setModal({ date: key })} />
              </article>
            );
          })}
        </section>
        <section className="someday" aria-label="Someday">
          <h2>Someday</h2>
          <ul>{someday.map(t => item(t))}</ul>
        </section>
      </main>

      <button type="button" className="fab" aria-label="Nova tarefa (n)" onClick={() => setModal({ date: null })}><PlusIcon /></button>
      {modal && <TaskModal task={modal.task} defaultDate={modal.date} onClose={() => setModal(null)} onSubmit={save} />}
      {del && (
        <Modal title="Excluir tarefa" onClose={() => setDel(null)}>
          <p className="msg">Excluir “{del.title}”? Essa ação não pode ser desfeita.</p>
          <footer><button type="button" className="ghost" onClick={() => setDel(null)}>Cancelar</button><button type="button" className="danger" onClick={confirmDel}>DELETAR</button></footer>
        </Modal>
      )}
      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  );
}

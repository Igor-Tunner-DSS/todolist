import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GoogleStatus, SyncResult, Task, User } from './types';
import * as api from './services/api';
import { useDebounce } from './hooks/useDebounce';
import { useTheme } from './hooks/useTheme';
import { daysIn, iso, mondayIndex, monthTitle, todayISO, weekStartsOfMonth, weekday } from './utils/dates';
import { seasonOf } from './utils/season';
import { ChevronLeft, ChevronRight, GoogleCalendarIcon, InboxIcon, LogoutIcon, MoonIcon, PlusIcon, SearchIcon, SeasonIcon, SunIcon } from './components/Icons';
import TaskItem from './components/TaskItem';
import TaskModal from './components/TaskModal';
import Modal from './components/Modal';
import AuthScreen from './components/AuthScreen';
import GooglePanel from './components/GooglePanel';

const byDate = (a: Task, b: Task) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
const changed = (r?: SyncResult | null) => !!r && ((r.created ?? 0) + (r.updated ?? 0) + (r.deleted ?? 0) > 0);

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = verificando a sessão
  useEffect(() => {
    api.setUnauthorizedHandler(() => setUser(null));
    api.me().then(setUser).catch(() => setUser(null));
    return () => api.setUnauthorizedHandler(null);
  }, []);
  if (user === undefined) return <div className="app" aria-busy="true" />;
  if (user === null) return <AuthScreen onAuth={setUser} />;
  return <Planner user={user} onLogout={async () => { try { await api.logout(); } catch { /* sessão já inválida */ } setUser(null); }} />;
}

function Planner({ user, onLogout }: { user: User; onLogout(): void }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 300);
  const [modal, setModal] = useState<null | { task?: Task; date?: string | null }>(null);
  const [del, setDel] = useState<Task | null>(null);
  const [sel, setSel] = useState<Task['id'] | null>(null);
  const { theme, toggle } = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => { setToast({ msg, kind }); setTimeout(() => setToast(null), 4500); }, []);
  const fail = (e: unknown) => notify((e as Error).message || 'Algo deu errado.', 'error');

  const load = useCallback(async () => {
    setLoading(true);
    try { setTasks((await api.loadTasks(q)).tasks); } catch (e) { fail(e); } finally { setLoading(false); }
  }, [q]);
  useEffect(() => { load(); }, [load]);
  const reloadQuiet = useCallback(async () => { try { setTasks((await api.loadTasks(q)).tasks); } catch { /* mantém a lista atual */ } }, [q]);

  // ---------- Google Calendar (somente leitura) ----------
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [gOpen, setGOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);            // impede sincronizações redundantes simultâneas
  const weeksDone = useRef('');          // chave da última consulta de semanas (evita refazer a cada render)
  const autoDone = useRef(false);        // sincronização automática ao abrir: uma vez por carregamento
  const [retry, setRetry] = useState(0);
  const { y, m } = ym;
  const weeks = useMemo(() => weekStartsOfMonth(y, m), [y, m]);
  const weeksKey = weeks.join(',');
  const active = !!g?.connected && g.state === 'active' && (g.selectedCalendars ?? 0) > 0;

  const refreshStatus = useCallback(async () => { try { const s = await api.googleStatus(); setG(s); return s; } catch { return null; } }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // Retorno do consentimento do Google (?google=connected|denied|error): mostra o resultado e limpa a URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search); const r = p.get('google'); if (!r) return;
    const reason = p.get('reason');
    const msgs: Record<string, [string, 'ok' | 'error']> = {
      connected: ['Conta Google conectada. Escolha os calendários que deseja sincronizar.', 'ok'],
      denied: ['Autorização cancelada. Nada foi conectado.', 'error'],
      session_expired: ['Sua sessão expirou durante a conexão. Entre novamente e tente de novo.', 'error'],
      error: [reason === 'insufficient_scope' ? 'Permissões insuficientes: autorize a leitura de calendários e eventos.' : reason === 'bad_state' ? 'A conexão expirou ou é inválida. Tente conectar novamente.' : 'Não foi possível conectar ao Google. Tente novamente.', 'error'],
    };
    const [msg, kind] = msgs[r] ?? msgs.error; notify(msg, kind);
    if (r === 'connected') setGOpen(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, [notify]);

  // Sincronização completa (calendários + semanas visíveis). Manual = botão "Sync".
  const runSync = useCallback(async (manual: boolean) => {
    if (busy.current) return; busy.current = true; setSyncing(true);
    try {
      const a = await api.googleSync();
      if (a.status === 'skipped') { if (manual) notify('Já existe uma sincronização em andamento.'); return; }
      const b = await api.googleSyncWeeks(weeks, manual);
      weeksDone.current = weeksKey;
      if (changed(a) || changed(b)) await reloadQuiet();
      const bad = a.status === 'error' ? a : a.status === 'partial' ? a : b.status === 'partial' ? b : null;
      if (bad) notify(bad.message || 'Sincronização parcial: alguns calendários falharam. Você pode tentar de novo.', bad.status === 'error' ? 'error' : 'ok');
      else if (manual) notify(changed(a) || changed(b) ? `Sincronizado: ${(a.created ?? 0) + (b.created ?? 0)} nova(s), ${(a.updated ?? 0) + (b.updated ?? 0)} atualizada(s), ${(a.deleted ?? 0) + (b.deleted ?? 0)} removida(s).` : 'Tudo em dia: nenhuma mudança no Google Calendar.');
    } catch (e) { notify((e as Error).message, 'error'); }
    finally { busy.current = false; setSyncing(false); await refreshStatus(); }
  }, [weeks, weeksKey, notify, reloadQuiet, refreshStatus]);

  // Ao abrir o site: só sincroniza se a última sincronização estiver desatualizada (o servidor decide).
  useEffect(() => {
    if (!g || autoDone.current) return; autoDone.current = true;
    if (active && g.stale) runSync(false);
  }, [g, active, runSync]);

  // Recorrências sob demanda: só quando a semana visualizada muda (não a cada renderização).
  useEffect(() => {
    if (!active || busy.current || syncing || weeksDone.current === weeksKey) return;
    weeksDone.current = weeksKey; busy.current = true; setSyncing(true);
    api.googleSyncWeeks(weeks).then(async r => {
      if (r.status === 'skipped') { weeksDone.current = ''; setTimeout(() => setRetry(n => n + 1), 3000); return; } // outra sincronização em curso: tenta depois
      if (changed(r)) await reloadQuiet();
      if (r.status === 'partial') notify('Algumas semanas não puderam ser atualizadas. Use Sync para tentar de novo.', 'error');
    }).catch(e => { weeksDone.current = ''; notify((e as Error).message, 'error'); })
      .finally(() => { busy.current = false; setSyncing(false); refreshStatus(); });
  }, [active, weeksKey, weeks, syncing, retry, notify, reloadQuiet, refreshStatus]);

  const gChanged = useCallback(async (opts?: { reloadTasks?: boolean }) => { weeksDone.current = ''; await refreshStatus(); if (opts?.reloadTasks) await reloadQuiet(); }, [refreshStatus, reloadQuiet]);

  // ---------- tarefas ----------
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
      if (modal || del || gOpen || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(el.tagName)) return;
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

  const go = (d: number) => setYm(({ y, m }) => { const n = new Date(y, m + d, 1); return { y: n.getFullYear(), m: n.getMonth() }; });
  const today = todayISO();
  const days = Array.from({ length: daysIn(y, m) }, (_, i) => i + 1);
  const someday = sorted.filter(t => !t.due_date);
  const item = (t: Task, showDate = false) => <TaskItem key={t.id} task={t} showDate={showDate} selected={sel === t.id} onSelect={() => setSel(t.id)} onToggle={toggleTask} onEdit={t => setModal({ task: t })} onDelete={setDel} />;
  const gLabel = !g?.connected ? 'Google Calendar: desconectado' : g.state === 'needs_reauth' ? 'Google Calendar: reconexão necessária' : syncing ? 'Google Calendar: sincronizando' : 'Google Calendar: conectado';

  return (
    <div className="app">
      <header className="top">
        <div><h1>{monthTitle(y, m)}<span className="season"><SeasonIcon season={seasonOf(m)} /></span></h1>
          <p className="counts" aria-live="polite"><strong>{total}</strong> tarefas · <strong>{completed}</strong> concluídas</p></div>
        <div className="controls">
          <label className="search"><SearchIcon /><span className="sr">Buscar tarefas</span><input ref={searchRef} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar" /></label>
          <button type="button" className={`icon round gbtn${g?.connected ? (g.state === 'needs_reauth' ? ' warn' : ' on') : ''}${syncing ? ' syncing' : ''}`} aria-label={gLabel} title={gLabel} aria-busy={syncing} onClick={() => setGOpen(true)}><GoogleCalendarIcon size={18} /></button>
          <button type="button" className="icon round" aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'} onClick={toggle}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button type="button" className="icon round" aria-label={`Sair (${user.email})`} title={`Sair (${user.email})`} onClick={onLogout}><LogoutIcon /></button>
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
          <p className="msg">Excluir “{del.title}”? Essa ação não pode ser desfeita.{del.source === 'google' ? ' O evento no Google Calendar não será afetado.' : ''}</p>
          <footer><button type="button" className="ghost" onClick={() => setDel(null)}>Cancelar</button><button type="button" className="danger" onClick={confirmDel}>DELETAR</button></footer>
        </Modal>
      )}
      {gOpen && g && <GooglePanel status={g} syncing={syncing} onClose={() => setGOpen(false)} onSync={() => runSync(true)} onChanged={gChanged} notify={notify} />}
      {toast && <div className={`toast${toast.kind === 'ok' ? ' ok' : ''}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.msg}</div>}
    </div>
  );
}

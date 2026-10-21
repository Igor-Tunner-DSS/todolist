import { useCallback, useEffect, useState } from 'react';
import * as api from '../services/api';
import type { Choice } from '../services/api';
import type { GoogleCalendar, GoogleStatus } from '../types';
import Modal from './Modal';
import { AlertIcon, CheckCircleIcon, GoogleCalendarIcon, ListCheckIcon, PlugIcon, SyncIcon, UnlinkIcon } from './Icons';
import { fmtDateTime } from '../utils/dates';

interface P {
  status: GoogleStatus;
  syncing: boolean;
  onClose(): void;
  onSync(): void;                       // sincronização manual (botão "Sync")
  onChanged(opts?: { reloadTasks?: boolean }): void; // pede ao App para atualizar status/tarefas
  notify(msg: string, kind?: 'ok' | 'error'): void;
}
type View = 'main' | 'calendars' | 'disconnect';
interface Pending { count: number; run(choice: Choice): Promise<void> }

// Pergunta o que fazer com as tarefas importadas afetadas por uma mudança. As duas opções
// descrevem a consequência; nenhuma delas altera o Google Calendar.
function ChoiceBox({ count, keepText, removeText, busy, onConfirm, onCancel, confirmLabel }: { count: number; keepText: string; removeText: string; busy: boolean; onConfirm(c: Choice): void; onCancel(): void; confirmLabel: string }) {
  const [choice, setChoice] = useState<Choice>('keep');
  return (
    <fieldset className="choice">
      <legend>{count > 0 ? `${count} ${count === 1 ? 'tarefa importada é afetada' : 'tarefas importadas são afetadas'}. O que fazer com ${count === 1 ? 'ela' : 'elas'}?` : 'O que fazer com as tarefas já importadas?'}</legend>
      <label className="opt"><input type="radio" name="choice" checked={choice === 'keep'} onChange={() => setChoice('keep')} /><span><strong>Manter cópias locais</strong>{keepText}</span></label>
      <label className="opt"><input type="radio" name="choice" checked={choice === 'remove'} onChange={() => setChoice('remove')} /><span><strong>Remover do site</strong>{removeText}</span></label>
      <footer><button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancelar</button><button type="button" className={choice === 'remove' ? 'danger' : 'primary'} disabled={busy} onClick={() => onConfirm(choice)}>{busy ? 'Aguarde…' : confirmLabel}</button></footer>
    </fieldset>
  );
}

export default function GooglePanel({ status, syncing, onClose, onSync, onChanged, notify }: P) {
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cals, setCals] = useState<GoogleCalendar[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [range, setRange] = useState({ start: status.range?.start ?? '', end: status.range?.end ?? '' });
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => { if (status.range) setRange({ start: status.range.start, end: status.range.end }); }, [status.range?.start, status.range?.end]);

  const fail = (e: unknown) => { setErr((e as Error).message || 'Algo deu errado.'); };
  const needsChoice = (e: unknown) => e instanceof api.ApiError && e.code === 'CHOICE_REQUIRED' ? Number(e.extra.affectedTasks) || 0 : null;

  const connect = async () => {
    setBusy(true); setErr('');
    try { window.location.assign((await api.googleConnect()).url); } // segue para a tela de consentimento do Google
    catch (e) { fail(e); setBusy(false); }
  };

  const loadCals = useCallback(async (refresh: boolean) => {
    setBusy(true); setErr('');
    try { const l = await api.googleCalendars(refresh); setCals(l); setSel(new Set(l.filter(c => c.selected).map(c => c.id))); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }, []);
  const openCalendars = () => { setView('calendars'); setPending(null); loadCals(false); };

  const saveCals = async (choice?: Choice) => {
    setBusy(true); setErr('');
    try {
      const r = await api.googleSaveCalendars([...sel], choice);
      setPending(null);
      notify(r.sync?.status === 'ok' || !r.sync ? 'Calendários atualizados.' : (r.sync.message || 'Calendários salvos; a importação terminou com avisos.'), r.sync?.status === 'error' ? 'error' : 'ok');
      onChanged({ reloadTasks: true }); setView('main');
    } catch (e) {
      const n = needsChoice(e);
      if (n !== null) setPending({ count: n, run: c => saveCals(c) }); else fail(e);
    } finally { setBusy(false); }
  };

  const saveRange = async (choice?: Choice) => {
    setBusy(true); setErr('');
    try {
      if (!range.start || !range.end || range.start > range.end) throw new Error('A data inicial deve ser anterior ou igual à final.');
      const r = await api.googleSaveRange(range.start, range.end, choice);
      setPending(null); notify(r.sync?.status === 'error' ? (r.sync.message || 'Intervalo salvo, mas a sincronização falhou.') : 'Intervalo atualizado.', r.sync?.status === 'error' ? 'error' : 'ok');
      onChanged({ reloadTasks: true });
    } catch (e) {
      const n = needsChoice(e);
      if (n !== null) setPending({ count: n, run: c => saveRange(c) }); else fail(e);
    } finally { setBusy(false); }
  };

  const disconnect = async (choice: Choice) => {
    setBusy(true); setErr('');
    try { await api.googleDisconnect(choice); notify('Google Calendar desconectado.'); onChanged({ reloadTasks: true }); onClose(); }
    catch (e) { fail(e); setBusy(false); }
  };

  const reauth = status.connected && status.state === 'needs_reauth';
  const title = view === 'calendars' ? 'Gerenciar calendários' : view === 'disconnect' ? 'Desconectar' : 'Google Calendar';

  return (
    <Modal title={title} onClose={onClose} wide>
      {view === 'main' && (
        <div className="gpanel">
          <p className="hint"><GoogleCalendarIcon size={15} /> Importação somente leitura: o site lê seus eventos e os mostra como tarefas. Nada que você fizer aqui cria, altera ou exclui eventos no Google Calendar.</p>

          {!status.configured && <p className="note warn" role="status"><AlertIcon /> A integração não está configurada neste servidor. Veja o README para configurar as credenciais do Google.</p>}

          {!status.connected && status.configured && (
            <div className="row end"><button type="button" className="primary with-icon" onClick={connect} disabled={busy}><PlugIcon /> Conectar Google Calendar</button></div>
          )}

          {status.connected && (
            <>
              <dl className="facts">
                <div><dt>Estado</dt><dd>{reauth ? <span className="pill bad"><AlertIcon /> Reconexão necessária</span> : <span className="pill ok"><CheckCircleIcon /> Conectado</span>}</dd></div>
                <div><dt>Conta</dt><dd>{status.account?.email ?? 'Conta Google'}</dd></div>
                <div><dt>Última sincronização</dt><dd>{status.lastSyncAt ? fmtDateTime(status.lastSyncAt) : 'Ainda não sincronizado'}</dd></div>
                <div><dt>Calendários</dt><dd>{status.selectedCalendars ? `${status.selectedCalendars} selecionado${status.selectedCalendars > 1 ? 's' : ''}` : 'Nenhum selecionado'}</dd></div>
              </dl>
              {status.lastError && status.lastSyncStatus !== 'ok' && <p className="note warn" role="status"><AlertIcon /> {status.lastError}</p>}
              {reauth && <div className="row end"><button type="button" className="primary with-icon" onClick={connect} disabled={busy}><PlugIcon /> Conectar Google Calendar</button></div>}

              <div className="row wrap actions-row">
                <button type="button" className="ghost with-icon" onClick={onSync} disabled={syncing || reauth || !status.selectedCalendars} aria-busy={syncing}>
                  <span className={syncing ? 'spin' : ''}><SyncIcon /></span> {syncing ? 'Sincronizando…' : 'Sync'}
                </button>
                <button type="button" className="ghost with-icon" onClick={openCalendars} disabled={reauth}><ListCheckIcon /> Gerenciar calendários</button>
                <button type="button" className="ghost with-icon" onClick={() => { setView('disconnect'); setErr(''); }}><UnlinkIcon /> Desconectar</button>
              </div>

              <h3 className="sub">Intervalo de datas</h3>
              <div className="row wrap">
                <label className="inline" htmlFor="g-from">De<input id="g-from" type="date" value={range.start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} /></label>
                <label className="inline" htmlFor="g-to">Até<input id="g-to" type="date" value={range.end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} /></label>
                <button type="button" className="ghost" disabled={busy || reauth} onClick={() => saveRange()}>Salvar intervalo</button>
              </div>
              <p className="hint small">Só eventos dentro deste período são importados. Eventos repetidos são trazidos semana a semana, conforme você navega.</p>
              {pending && view === 'main' && (
                <ChoiceBox count={pending.count} busy={busy} confirmLabel="Aplicar" onCancel={() => setPending(null)} onConfirm={pending.run}
                  keepText="As tarefas fora do novo intervalo continuam no site, mas deixam de ser atualizadas pelo Google."
                  removeText="As tarefas importadas fora do novo intervalo são excluídas do site. Tarefas criadas por você não são afetadas." />
              )}
            </>
          )}
          {err && <p className="err" role="alert">{err}</p>}
        </div>
      )}

      {view === 'calendars' && (
        <div className="gpanel">
          <p className="hint small">Escolha quais calendários virarão tarefas. Eventos de calendários desmarcados não são importados.</p>
          {cals === null && <p className="hint">{busy ? 'Carregando calendários…' : 'Não foi possível carregar a lista.'}</p>}
          {cals && cals.length === 0 && <p className="hint">Nenhum calendário disponível nesta conta.</p>}
          {cals && (
            <ul className="callist">
              {cals.map(c => (
                <li key={c.id}>
                  <label htmlFor={`cal-${c.id}`}>
                    <input id={`cal-${c.id}`} type="checkbox" checked={sel.has(c.id)} onChange={e => setSel(s => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                    <span className="dot" style={{ background: c.color ?? 'var(--mute)' }} aria-hidden="true" />
                    <span className="calname">{c.summary}</span>
                    {c.importedTasks > 0 && <span className="count">{c.importedTasks} {c.importedTasks === 1 ? 'tarefa' : 'tarefas'}</span>}
                  </label>
                  {c.lastError && <p className="err inl">{c.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
          {pending && (
            <ChoiceBox count={pending.count} busy={busy} confirmLabel="Salvar seleção" onCancel={() => setPending(null)} onConfirm={pending.run}
              keepText="As tarefas dos calendários desmarcados continuam no site como cópias locais, sem sincronização. Se marcar o calendário de novo, elas voltam a ser atualizadas."
              removeText="As tarefas importadas dos calendários desmarcados são excluídas do site. Tarefas criadas por você não são afetadas." />
          )}
          {err && <p className="err" role="alert">{err}</p>}
          {!pending && (
            <footer>
              <button type="button" className="ghost" onClick={() => loadCals(true)} disabled={busy}>Atualizar lista</button>
              <button type="button" className="ghost" onClick={() => { setView('main'); setErr(''); }}>Voltar</button>
              <button type="button" className="primary" onClick={() => saveCals()} disabled={busy || !cals}>{busy ? 'Salvando…' : 'Salvar seleção'}</button>
            </footer>
          )}
        </div>
      )}

      {view === 'disconnect' && (
        <div className="gpanel">
          <p className="hint">Ao desconectar, o acesso ao Google é revogado e a sincronização é encerrada. Seu Google Calendar não é alterado.</p>
          <ChoiceBox count={0} busy={busy} confirmLabel="Desconectar" onCancel={() => { setView('main'); setErr(''); }} onConfirm={disconnect}
            keepText="As tarefas já importadas ficam no site como cópias locais. Elas nunca mais serão atualizadas nem excluídas pelo Google."
            removeText="As tarefas importadas e os dados da integração são excluídos do site. Tarefas criadas por você permanecem." />
          {err && <p className="err" role="alert">{err}</p>}
        </div>
      )}
    </Modal>
  );
}

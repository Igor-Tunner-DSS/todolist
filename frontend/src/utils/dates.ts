export const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const todayISO = () => { const n = new Date(); return iso(n.getFullYear(), n.getMonth(), n.getDate()); };
export const isOverdue = (due: string | null, done: boolean) => !!due && !done && due < todayISO();
export const mondayIndex = (y: number, m: number, d: number) => (new Date(y, m, d).getDay() + 6) % 7;
export const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
export const fmtShort = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }); };
export const monthTitle = (y: number, m: number) => new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
export const weekday = (y: number, m: number, d: number) => new Date(y, m, d).toLocaleDateString('en-US', { weekday: 'short' });
// Segundas-feiras (YYYY-MM-DD) das semanas que aparecem na grade do mês (até 6).
export const weekStartsOfMonth = (y: number, m: number): string[] => {
  const out: string[] = [];
  const first = new Date(y, m, 1 - mondayIndex(y, m, 1));
  const last = new Date(y, m, daysIn(y, m));
  for (let d = first; d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) out.push(iso(d.getFullYear(), d.getMonth(), d.getDate()));
  return out;
};
export const fmtDateTime = (isoStr: string) => new Date(isoStr).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

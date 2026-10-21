// Conversão pura (sem I/O) de evento do Google Calendar em campos de tarefa.

export const META_HEADER = '---\nImportado do Google Calendar';
const META_RE = /(?:^|\n\n)---\nImportado do Google Calendar\n[\s\S]*$/;
const pad = (n) => String(n).padStart(2, '0');

// Remove o bloco gerado pela integração, devolvendo só a descrição original.
export const stripMeta = (text) => String(text ?? '').replace(META_RE, '').trim();

// Descrições do Google podem conter HTML: tratamos como texto não confiável e removemos as marcas.
export function cleanDescription(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

// Data (YYYY-MM-DD) e hora (HH:mm) locais de um instante no fuso indicado.
function localParts(dateTime, tz) {
    const d = new Date(dateTime);
    if (Number.isNaN(d.getTime())) return null;
    if (!tz || !validTz(tz)) return { date: String(dateTime).slice(0, 10), time: String(dateTime).slice(11, 16) };
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}

const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export { addDays };

export function eventDate(ev, calendarTz) {
    const s = ev?.start;
    if (!s) return null;
    if (s.date) return s.date;
    if (s.dateTime) return localParts(s.dateTime, s.timeZone || calendarTz)?.date ?? null;
    return null;
}

// Retorna { title, due_date, original, description, allDay } ou null se o evento não tem início válido.
export function buildTask(ev, { calendarName = '', calendarTz = null } = {}) {
    const due = eventDate(ev, calendarTz);
    if (!due) return null;

    const title = (typeof ev.summary === 'string' && ev.summary.trim() ? ev.summary.trim() : '(Sem título)').slice(0, 255);
    const original = cleanDescription(ev.description);
    const lines = [];

    if (ev.start.date) {
        lines.push('Horário: Dia inteiro');
        const last = ev.end?.date ? addDays(ev.end.date, -1) : due; // fim é exclusivo no Google
        if (last > due) lines.push(`Término: ${br(last)}`);
    } else {
        const tz = ev.start.timeZone || calendarTz;
        const s = localParts(ev.start.dateTime, tz);
        const e = ev.end?.dateTime ? localParts(ev.end.dateTime, ev.end.timeZone || tz) : null;
        if (e && e.date !== s.date) {
            lines.push(`Horário: ${s.time}`);
            lines.push(`Término: ${br(e.date)} ${e.time}`);
        } else {
            lines.push(`Horário: ${e ? `${s.time}–${e.time}` : s.time}`);
        }
        if (tz && validTz(tz)) lines.push(`Fuso horário: ${tz}`);
    }
    if (typeof ev.location === 'string' && ev.location.trim()) lines.push(`Local: ${ev.location.trim().replace(/\s*\n\s*/g, ', ')}`);
    if (calendarName) lines.push(`Calendário: ${calendarName}`);

    const block = `${META_HEADER}\n${lines.join('\n')}`;
    const description = original ? `${original}\n\n${block}` : block;
    return { title, due_date: due, original, description, allDay: Boolean(ev.start.date) };
}

// Segunda-feira (YYYY-MM-DD) da semana que contém a data.
export function weekStartOf(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export { pad };

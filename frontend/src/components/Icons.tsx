import type { ReactNode } from 'react';
import type { Season } from '../utils/season';
const I = ({ children, size = 18, label }: { children: ReactNode; size?: number; label?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>{children}</svg>
);
export const SearchIcon = () => <I><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></I>;
export const SunIcon = () => <I><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></I>;
export const MoonIcon = () => <I><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></I>;
export const ChevronLeft = () => <I><path d="m15 5-7 7 7 7" /></I>;
export const ChevronRight = () => <I><path d="m9 5 7 7-7 7" /></I>;
export const PlusIcon = () => <I size={22}><path d="M12 5v14M5 12h14" /></I>;
export const PencilIcon = () => <I size={16}><path d="m4 20 1-4L16.500 4.500a2 2 0 0 1 3 3L8 19l-4 1Z" /></I>;
export const TrashIcon = () => <I size={16}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></I>;
export const CalendarIcon = () => <I size={16}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4" /></I>;
export const CloseIcon = () => <I><path d="M6 6l12 12M18 6 6 18" /></I>;
export const CheckIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.500 4.500 4.500L19 7.500" /></svg>;
export const ClockIcon = () => <I size={13}><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></I>;
export const InboxIcon = () => <I size={30}><path d="M4 13 6.500 5h11L20 13v6H4v-6Z" /><path d="M4 13h4.500l1 2h5l1-2H20" /></I>;
export const SeasonIcon = ({ season }: { season: Season }) => {
  const label = { summer: 'Verão', autumn: 'Outono', winter: 'Inverno', spring: 'Primavera' }[season];
  const g = {
    summer: <><circle cx="12" cy="12" r="3.600" /><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M5.300 18.700l2.100-2.100M16.600 7.400l2.100-2.100" /></>,
    autumn: <><path d="M5 7c5 0 9 3 9 8-5 0-9-3-9-8Z" /><path d="M5 7c3 2 6 5 9 8" /><path d="M14 3.500c3 .3 5.500 2.300 5.500 5.500-3 0-5.300-2-5.500-5.500Z" /></>,
    winter: <><path d="M12 3v18M4.200 7.500l15.600 9M19.800 7.500l-15.600 9" /><path d="m9.500 4.500 2.500 2 2.500-2M9.500 19.500l2.500-2 2.500 2" /></>,
    spring: <><circle cx="12" cy="12" r="1.800" /><path d="M12 10.200C10.500 7.500 10.800 4.500 12 3c1.200 1.500 1.500 4.500 0 7.200ZM13.800 12c2.700-1.500 5.700-1.200 7.200 0-1.500 1.200-4.500 1.500-7.200 0ZM12 13.800c1.500 2.700 1.200 5.700 0 7.200-1.200-1.500-1.500-4.500 0-7.200ZM10.200 12C7.500 13.500 4.500 13.200 3 12c1.500-1.200 4.500-1.500 7.200 0Z" /></>,
  }[season];
  return <I size={26} label={label}>{g}</I>;
};
// Google Calendar: ícone próprio (calendário com "31" estilizado), em traço, que herda a cor do tema.
export const GoogleCalendarIcon = ({ size = 13 }: { size?: number }) => <I size={size}><rect x="3.500" y="4.500" width="17" height="16" rx="2.500" /><path d="M3.500 9.500h17M8 3v3M16 3v3" /><path d="M9.500 13.500h1.500v4M13.500 13.500h2.500M13.500 17.500h2.500M14 15.500h2" /></I>;
export const SyncIcon = () => <I size={16}><path d="M20 11a8 8 0 0 0-14-4.500L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14 4.500L20 15" /><path d="M20 20v-5h-5" /></I>;
export const LogoutIcon = () => <I><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></I>;
export const ListCheckIcon = () => <I size={16}><path d="M4 7l1.500 1.500L8 6M4 13l1.500 1.500L8 12M4 19l1.500 1.500L8 18" /><path d="M12 7h8M12 13h8M12 19h8" /></I>;
export const UnlinkIcon = () => <I size={16}><path d="M9 15 6.500 17.500a3.500 3.500 0 0 1-5-5L4 10M15 9l2.500-2.500a3.500 3.500 0 0 1 5 5L20 14" /><path d="M8 8 5 5M16 16l3 3" /></I>;
export const PlugIcon = () => <I size={16}><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v5" /></I>;
export const AlertIcon = () => <I size={16}><path d="M12 4 3 19h18L12 4Z" /><path d="M12 10v4M12 17v.01" /></I>;
export const CheckCircleIcon = () => <I size={16}><circle cx="12" cy="12" r="8.500" /><path d="m8.500 12.200 2.500 2.500 4.500-5" /></I>;

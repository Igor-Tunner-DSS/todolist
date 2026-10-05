export type Season = 'summer' | 'autumn' | 'winter' | 'spring';
const SOUTH = /^(Australia|Antarctica|Pacific\/(Auckland|Fiji|Tongatapu|Apia)|Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Luanda)|America\/(Sao_Paulo|Argentina|Buenos_Aires|Santiago|Lima|La_Paz|Asuncion|Montevideo|Bahia|Fortaleza|Recife|Manaus|Cuiaba|Campo_Grande|Belem|Maceio|Araguaina|Porto_Velho|Rio_Branco|Noronha|Cordoba|Punta_Arenas))/;
const NORTH = /^(Europe|Asia|Arctic|Atlantic|America|Africa|Pacific\/(Honolulu|Guam))/;
export function isSouthern(): boolean {
  try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; if (SOUTH.test(tz)) return true; if (NORTH.test(tz)) return false; } catch { /* ignora */ }
  return true; // padrão: Brasil / hemisfério sul
}
export function seasonOf(month: number, south = isSouthern()): Season {
  const n: Season[] = ['winter','winter','spring','spring','spring','summer','summer','summer','autumn','autumn','autumn','winter'];
  const s = n[month];
  return south ? ({ winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as const)[s] : s;
}

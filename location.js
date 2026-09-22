export const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[-–—]/g,' ').replace(/\s+/g,' ').trim();
export function normalizeDistrict(value) {
  const name = String(value || '').replace(/^okres\s*/i,'').trim();
  if (normalizeName(name) === 'praha vychod') return 'Praha-východ';
  if (normalizeName(name) === 'praha zapad') return 'Praha-západ';
  return name;
}
export function eventLocation(event = {}) {
  if (event.source === 'praha' || event.region === 'Hlavní město Praha') {
    const municipality = String(event.cityText || event.city_text || 'Praha').trim() || 'Praha';
    const detail = String(event.addressText || event.address_text || event.placeText || event.place_text || '').trim();
    const locality = String(event.neighborhoodText || event.neighborhood_text || event.locality_text || '').trim();
    return {source:'praha', municipality, detail:normalizeName(detail)===normalizeName(municipality)?'':detail, locality, district:municipality, state:'Hlavní město Praha', country:'Česko'};
  }
  const lines = String(event.descriptionRaw || event.description_raw || '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ').split(/[\r\n]+/).map(s=>s.trim()).filter(Boolean);
  const district = normalizeDistrict(event.district_text || lines.find(s=>/^okres\s+/i.test(s)) || '');
  const places = lines.filter(s=>! /^(stav\s*:|ukon(?:čení|ceni)\s*:|okres\s+)/i.test(s));
  const municipality = (places.at(-1) || event.cityText || event.city_text || '').replace(/^obec\s*:\s*/i,'').trim();
  const detail = places.length > 1 ? places.slice(0,-1).join(', ') : String(event.placeText || event.place_text || '').trim();
  const locality = String(event.locality_text || places.find(s=>/^část obce\s*:/i.test(s))?.replace(/^část obce\s*:\s*/i,'') || '').trim();
  return {source:'stredocesky', municipality, detail:normalizeName(detail)===normalizeName(municipality)?'':detail, locality, district, state:'Středočeský kraj', country:'Česko'};
}

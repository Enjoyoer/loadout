// Emit a script for the actual Paseo web origin. Native clients use the picker.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
export function carryPreferences(previous, catalogs) {
  const provider = previous.provider || 'codex';
  const oldCatalog = catalogs[provider] || [];
  const prefs = previous.providerPreferences?.[provider] || {};
  const old = oldCatalog.find(row => row.id === prefs.model) || oldCatalog.find(row => row.isDefault) || oldCatalog[0];
  if (!old) throw Error('previous provider catalog required');
  const pi = (catalogs.pi || []).filter(row => row.id === old.id || row.id.slice(row.id.indexOf('/') + 1) === old.id || (row.label && row.label === old.label));
  if (pi.length !== 1) throw Error('previous model has no unique Pi catalog mapping; retain original route');
  const thinking = prefs.thinkingByModel?.[old.id] || old.defaultThinkingOptionId || old.thinkingOptions?.find(row => row.isDefault)?.id;
  if (thinking && !pi[0].thinkingOptions?.some(row => row.id === thinking)) throw Error('previous thinking unavailable on Pi; retain original route');
  return { modelId: pi[0].id, thinking };
}
export function appDefaultsScript(modelId, thinking, rollback = false) {
  if (typeof modelId !== 'string' || !modelId.trim()) throw Error('catalog model ID required');
  return preferenceScript(`const choice = ${JSON.stringify({modelId,thinking})};`, rollback);
}
export function inheritedAppDefaultsScript(catalogs, rollback = false) {
  return preferenceScript(`const choice = (${carryPreferences.toString()})(previous, ${JSON.stringify(catalogs)});`, rollback);
}
function preferenceScript(choose, rollback) {
  return `(() => {
    const key = '@paseo:create-agent-preferences';
    const backup = key + ':loadout-pi-backup';
    ${rollback ? `const saved = localStorage.getItem(backup);
    if (saved === null) throw Error('no Pi preference backup');
    const previous = JSON.parse(saved);
    if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous);
    localStorage.removeItem(backup);` : `const previous = JSON.parse(localStorage.getItem(key) || '{}');
    ${choose}
    if (localStorage.getItem(backup) === null) localStorage.setItem(backup, JSON.stringify(localStorage.getItem(key)));
    previous.provider = 'pi';
    previous.launchTarget = {kind: 'chat'};
    previous.providerPreferences ||= {};
    previous.providerPreferences.pi = {model: choice.modelId, thinkingByModel: choice.thinking ? { [choice.modelId]: choice.thinking } : {}};
    localStorage.setItem(key, JSON.stringify(previous));`}
    return JSON.parse(localStorage.getItem(key) || '{}');
  })()`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const catalogs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(inheritedAppDefaultsScript(catalogs, process.argv[3] === '--rollback'));
}

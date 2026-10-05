import { api } from './util.js';

export const app = { meta: null };

export async function loadMeta() {
  app.meta = await api.get('/api/meta');
  return app.meta;
}

// The category list grows as new ones are typed in, and the eBay connection can change on the Settings page
export async function refreshMeta() {
  try { app.meta = await api.get('/api/meta'); } catch { /* keep old */ }
}

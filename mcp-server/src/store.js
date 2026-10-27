// Tiny JSON-file store for the content calendar (same fields as the dashboard's posts).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATUSES = ['Draft', 'In Review', 'Approved', 'Scheduled', 'Published'];

export class CalendarStore {
  constructor(file) { this.file = resolve(file || './data/calendar.json'); }
  load() {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return []; }
  }
  save(posts) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(posts, null, 2));
    renameSync(tmp, this.file);
  }
  list({ status, from, to } = {}) {
    return this.load().filter(p => (!status || p.status === status) && (!from || p.date >= from) && (!to || p.date <= to))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }
  add(p) {
    const posts = this.load();
    const post = { id: randomUUID().slice(0, 8), platform: 'Instagram', format: 'Reel', status: 'Draft', notes: '', ...p };
    posts.push(post); this.save(posts); return post;
  }
  update(id, patch) {
    const posts = this.load(); const i = posts.findIndex(p => p.id === id);
    if (i < 0) throw new Error(`No calendar item with id ${id}`);
    posts[i] = { ...posts[i], ...patch, id }; this.save(posts); return posts[i];
  }
}

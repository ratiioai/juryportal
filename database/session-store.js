const session = require('express-session');
class SQLiteSessionStore extends session.Store {
    constructor(db) { super(); this.db = db; }
    async get(sid, callback) {
        try {
            const row = await this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
            callback(null, row ? JSON.parse(row.data) : null);
        } catch (error) { callback(error); }
    }
    async set(sid, value, callback = () => {}) {
        try {
            const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 12 * 3600000;
            await this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(sid, JSON.stringify(value), expires);
            await this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
            callback();
        } catch (error) { callback(error); }
    }
    touch(sid, value, callback) { this.set(sid, value, callback); }
    async destroy(sid, callback = () => {}) {
        try { await this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(); }
        catch (error) { callback(error); }
    }
}
module.exports = SQLiteSessionStore;

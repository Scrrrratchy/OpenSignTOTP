// Parse normally caches session authentication. Always consult MongoDB for
// sessions so revocation takes effect on every replica, including offline resets.
// Keep a small TTL cache for the other Parse cache namespaces.
export default class SessionCache {
  constructor() {
    this.entries = new Map();
  }
  async get(key) {
    if (key.includes(':user:')) return null;
    const record = this.entries.get(key);
    if (!record || record.expires <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return record.value;
  }
  async put(key, value, ttl = 5000) {
    if (key.includes(':user:')) return;
    if (this.entries.size >= 10000) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, { value, expires: Date.now() + ttl });
  }
  async del(key) {
    this.entries.delete(key);
  }
  async clear() {
    this.entries.clear();
  }
}

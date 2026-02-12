/**
 * ═══════════════════════════════════════════════════════════════════════
 *  SecureChat — core.js
 *  Foundation Module: CONFIG · EventBus · AppState · CryptoEngine
 *                     SupabaseService · Utils
 *  ES6 Module — zero runtime deps except Supabase CDN
 * ═══════════════════════════════════════════════════════════════════════
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────
export const CONFIG = Object.freeze({
  // ── Supabase credentials (replace before deploy) ──
  SUPABASE_URL: 'https://jotezuumxzizgejfthcc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_DUpzh7Nls9meEhwAvo56TA_mHLHefzU',

  // ── Cryptography ──
  PBKDF2_ITERATIONS: 100_000,
  AES_KEY_LENGTH: 256,
  IV_LENGTH: 12,       // 96-bit IV for AES-GCM
  SALT_LENGTH: 16,     // 128-bit salt

  // ── Application limits ──
  MAX_MESSAGE_LENGTH: 10_000,
  MESSAGE_PAGE_SIZE: 50,
  MESSAGE_CHUNK_SIZE: 10_240, // 10 KB
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10 MB
  SUPPORTED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],

  // ── Passkey rules ──
  PASSKEY_MIN_LENGTH: 4,
  PASSKEY_LOCKOUT_ATTEMPTS: 5,
  PASSKEY_LOCKOUT_DURATION_MS: 60_000,

  // ── Timing ──
  TYPING_DEBOUNCE_MS: 1_000,
  TYPING_TIMEOUT_MS: 3_000,
  SESSION_TIMEOUT_MS: 30 * 60 * 1_000,
  RECONNECT_INTERVAL_MS: 5_000,
  TOAST_DURATION_MS: 4_000,

  // ── UI ──
  SCROLL_THRESHOLD: 150,
});


// ─────────────────────────────────────────────────────────────
//  EVENT BUS — Internal reactive pub/sub
// ─────────────────────────────────────────────────────────────
class _EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} unsubscribe handle
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  /**
   * Subscribe once — auto-unsubscribes after first fire.
   */
  once(event, callback) {
    const unsub = this.on(event, (data) => {
      unsub();
      callback(data);
    });
    return unsub;
  }

  off(event, callback) {
    this._listeners.get(event)?.delete(callback);
  }

  /**
   * Emit event to all subscribers.
   */
  emit(event, data) {
    const cbs = this._listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(data);
      } catch (e) {
        console.error(`[EventBus] Error in handler for "${event}":`, e);
      }
    }
  }

  /** Remove every listener. */
  clear() {
    this._listeners.clear();
  }
}

export const eventBus = new _EventBus();


// ─────────────────────────────────────────────────────────────
//  APP STATE — Reactive centralised store (singleton)
// ─────────────────────────────────────────────────────────────
const INITIAL_STATE = () => ({
  // Auth
  user: null,
  session: null,
  profile: null,

  // Social
  contacts: [],
  contactRequests: [],
  blockedUsers: [],

  // Conversations
  conversations: [],
  activeConversationId: null,

  // Messages — keyed by conversation ID
  messages: {},              // { [convId]: Message[] }
  messagePagination: {},     // { [convId]: { hasMore:bool, loading:bool } }

  // Passkeys — **in-memory ONLY**, never persisted
  passkeys: {},              // { [convId]: string }
  derivedKeys: {},           // { [convId]: CryptoKey }
  passkeySalts: {},          // { [convId]: base64 }
  passkeyAttempts: {},       // { [convId]: { count, lockedUntil } }

  // Presence
  onlineUsers: new Set(),
  typingUsers: {},           // { [convId]: Set<userId> }
  lastSeen: {},              // { [userId]: ISO string }

  // UI
  theme: localStorage.getItem('securechat_theme') || 'dark',
  sidebarOpen: window.innerWidth > 768,
  activeView: 'chat',       // chat | contacts | settings | profile
  connectionStatus: 'connected',

  // Unread
  unreadCounts: {},          // { [convId]: number }
  totalUnread: 0,

  // Offline queue
  messageQueue: [],

  // Boot flag
  initialized: false,
});

class _AppState {
  constructor() {
    this._state = INITIAL_STATE();
    /** @type {Map<string, Set<Function>>} */
    this._watchers = new Map();
  }

  /** Read a top-level key. */
  get(key) {
    return this._state[key];
  }

  /** Write a top-level key and notify watchers. */
  set(key, value) {
    const old = this._state[key];
    this._state[key] = value;
    this._notify(key, value, old);
    eventBus.emit('state:change', { key, value, old });
    eventBus.emit(`state:${key}`, { value, old });
  }

  /**
   * Watch a key for changes.
   * @returns {Function} unsubscribe
   */
  watch(key, callback) {
    if (!this._watchers.has(key)) {
      this._watchers.set(key, new Set());
    }
    this._watchers.get(key).add(callback);
    return () => this._watchers.get(key)?.delete(callback);
  }

  /**
   * Batch-set multiple keys (each key's watchers still fire).
   */
  batch(updates) {
    const changes = [];
    for (const [key, value] of Object.entries(updates)) {
      const old = this._state[key];
      this._state[key] = value;
      this._notify(key, value, old);
      changes.push({ key, value, old });
    }
    eventBus.emit('state:batch', changes);
  }

  /**
   * Convenience: update a sub-key inside an object-valued top-level key.
   * e.g. merge('messages', convId, [...])
   */
  merge(key, subKey, value) {
    const current = this._state[key] ?? {};
    const old = current[subKey];
    current[subKey] = value;
    this._state[key] = current;           // keep same ref — intentional
    this._notify(key, this._state[key], undefined);
    eventBus.emit(`state:${key}:${subKey}`, { value, old });
  }

  /** Debug-safe snapshot (redacts secrets). */
  snapshot() {
    return JSON.parse(JSON.stringify(this._state, (_key, val) => {
      if (val instanceof Set) return [...val];
      if (val instanceof CryptoKey) return '[CryptoKey]';
      if (_key === 'passkeys' || _key === 'derivedKeys') return '[REDACTED]';
      return val;
    }));
  }

  /** Full reset — zeroes passkeys first. */
  reset() {
    // Zero-out sensitive material
    const pk = this._state.passkeys;
    for (const k of Object.keys(pk)) { pk[k] = ''; delete pk[k]; }
    const dk = this._state.derivedKeys;
    for (const k of Object.keys(dk)) { dk[k] = null; delete dk[k]; }

    const preservedTheme = this._state.theme;
    this._state = INITIAL_STATE();
    this._state.theme = preservedTheme;
    eventBus.emit('state:reset');
  }

  // ── private ──

  /** @private */
  _notify(key, value, old) {
    const cbs = this._watchers.get(key);
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(value, old); } catch (e) { console.error(`[AppState] Watcher error [${key}]:`, e); }
    }
  }
}

export const AppState = new _AppState();


// ─────────────────────────────────────────────────────────────
//  CRYPTO ENGINE — AES-256-GCM + PBKDF2 key derivation
// ─────────────────────────────────────────────────────────────
export const CryptoEngine = {

  // ── Encoding helpers ──────────────────────────────────────

  /** @returns {Uint8Array} */
  getRandomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },

  /** ArrayBuffer | Uint8Array → base-64 string */
  bufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },

  /** base-64 string → Uint8Array */
  base64ToBuffer(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },

  encode(str) { return new TextEncoder().encode(str); },
  decode(buf) { return new TextDecoder().decode(buf); },

  // ── Key derivation ────────────────────────────────────────

  /**
   * PBKDF2  →  AES-256-GCM CryptoKey
   * @param {string}     passkey
   * @param {Uint8Array} salt
   * @returns {Promise<CryptoKey>}
   */
  async deriveKey(passkey, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      this.encode(passkey),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: CONFIG.PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: CONFIG.AES_KEY_LENGTH },
      false,          // non-extractable
      ['encrypt', 'decrypt']
    );
  },

  /**
   * Get-or-derive a key for a conversation (caches in AppState).
   */
  async getKey(conversationId, passkey, saltBase64) {
    const cached  = AppState.get('derivedKeys')[conversationId];
    const current = AppState.get('passkeys')[conversationId];
    if (cached && current === passkey) return cached;

    const salt = this.base64ToBuffer(saltBase64);
    const key  = await this.deriveKey(passkey, salt);

    const keys = AppState.get('derivedKeys');
    keys[conversationId] = key;
    AppState.set('derivedKeys', keys);
    return key;
  },

  // ── Encrypt / Decrypt (text) ──────────────────────────────

  /**
   * Encrypt plaintext → { ciphertext, iv }  (both base-64)
   */
  async encrypt(plaintext, passkey, saltBase64) {
    if (!plaintext || !passkey || !saltBase64) throw new Error('Missing encryption parameters');

    const salt = this.base64ToBuffer(saltBase64);
    const key  = await this.deriveKey(passkey, salt);
    const iv   = this.getRandomBytes(CONFIG.IV_LENGTH);

    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      this.encode(plaintext)
    );
    return { ciphertext: this.bufferToBase64(ct), iv: this.bufferToBase64(iv) };
  },

  /**
   * Decrypt ciphertext → { text, success }
   * Wrong key? Returns deterministic gibberish, never throws.
   */
  async decrypt(ciphertextB64, ivB64, passkey, saltBase64) {
    if (!ciphertextB64 || !ivB64 || !passkey || !saltBase64) {
      return { text: '\u{1F512} Missing decryption data', success: false };
    }
    try {
      const salt = this.base64ToBuffer(saltBase64);
      const key  = await this.deriveKey(passkey, salt);
      const iv   = this.base64ToBuffer(ivB64);
      const ct   = this.base64ToBuffer(ciphertextB64);

      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return { text: this.decode(plain), success: true };
    } catch {
      return { text: this.generateGibberish(ciphertextB64), success: false };
    }
  },

  // ── Encrypt / Decrypt (files) ─────────────────────────────

  /**
   * @param {ArrayBuffer} fileData
   * @returns {Promise<{ciphertext: ArrayBuffer, iv: string}>}
   */
  async encryptFile(fileData, passkey, saltBase64) {
    const salt = this.base64ToBuffer(saltBase64);
    const key  = await this.deriveKey(passkey, salt);
    const iv   = this.getRandomBytes(CONFIG.IV_LENGTH);
    const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fileData);
    return { ciphertext: ct, iv: this.bufferToBase64(iv) };
  },

  /**
   * @returns {Promise<ArrayBuffer|null>}
   */
  async decryptFile(ciphertext, ivB64, passkey, saltBase64) {
    try {
      const salt = this.base64ToBuffer(saltBase64);
      const key  = await this.deriveKey(passkey, salt);
      const iv   = this.base64ToBuffer(ivB64);
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch {
      return null;
    }
  },

  // ── Gibberish generator ───────────────────────────────────

  /**
   * Deterministic "unicode salad" derived from ciphertext bytes
   * so wrong-key display is stable across renders.
   */
  generateGibberish(ciphertextB64) {
    const bytes = this.base64ToBuffer(ciphertextB64);
    const ranges = [
      [0x0E00, 0x0E7F],   // Thai
      [0x10A0, 0x10FF],   // Georgian
      [0x0530, 0x058F],   // Armenian
      [0x2200, 0x22FF],   // Math operators
      [0x0400, 0x04FF],   // Cyrillic
      [0x3040, 0x309F],   // Hiragana
    ];
    let out = '';
    const len = Math.min(bytes.length, 40);
    for (let i = 0; i < len; i++) {
      const [lo, hi] = ranges[bytes[i] % ranges.length];
      out += String.fromCharCode(lo + (bytes[i] % (hi - lo)));
      if (i > 0 && i % 7 === 0) out += ' ';
    }
    return out || '\u{1F512} \u2022\u2022\u2022\u2022\u2022\u2022';
  },

  // ── Helpers ───────────────────────────────────────────────

  /** Generate a fresh per-conversation salt (base-64). */
  generateSalt() {
    return this.bufferToBase64(this.getRandomBytes(CONFIG.SALT_LENGTH));
  },

  /** UUID-based idempotency key. */
  generateId() {
    return crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  },

  /**
   * Passkey strength meter.
   * @returns {{ score:number, label:string, color:string }}
   */
  measureStrength(passkey) {
    if (!passkey) return { score: 0, label: '', color: '' };

    let s = 0;
    if (passkey.length >= 4)  s++;
    if (passkey.length >= 8)  s++;
    if (passkey.length >= 12) s++;
    if (passkey.length >= 20) s++;
    if (/[a-z]/.test(passkey))        s++;
    if (/[A-Z]/.test(passkey))        s++;
    if (/[0-9]/.test(passkey))        s++;
    if (/[^a-zA-Z0-9]/.test(passkey)) s++;
    const unique = new Set(passkey).size;
    if (unique >= 6)  s++;
    if (unique >= 10) s++;
    if (/(.)\1{2,}/.test(passkey)) s--;

    const n = Math.max(0, Math.min(4, Math.floor(s / 2.5)));
    const levels = [
      { label: 'Very Weak',   color: '#ef4444' },
      { label: 'Weak',        color: '#f97316' },
      { label: 'Fair',        color: '#eab308' },
      { label: 'Strong',      color: '#22c55e' },
      { label: 'Very Strong', color: '#06b6d4' },
    ];
    return { score: n, ...levels[n] };
  },

  // ── Passkey management (memory only) ─────────────────────

  setPasskey(conversationId, passkey) {
    const pk = AppState.get('passkeys');
    pk[conversationId] = passkey;
    AppState.set('passkeys', { ...pk });
    // Invalidate cached derived key — will re-derive on next op
    const dk = AppState.get('derivedKeys');
    delete dk[conversationId];
    AppState.set('derivedKeys', { ...dk });
  },

  getPasskey(conversationId) {
    return AppState.get('passkeys')[conversationId] ?? null;
  },

  /** Is the user locked out of entering a passkey for this conversation? */
  isLockedOut(conversationId) {
    const a = AppState.get('passkeyAttempts')[conversationId];
    if (!a) return false;
    if (a.count < CONFIG.PASSKEY_LOCKOUT_ATTEMPTS) return false;
    if (Date.now() > a.lockedUntil) {
      // Lockout expired — reset
      const all = AppState.get('passkeyAttempts');
      delete all[conversationId];
      AppState.set('passkeyAttempts', { ...all });
      return false;
    }
    return true;
  },

  /** @returns {{ count:number, lockedUntil:number|null }} */
  recordFailedAttempt(conversationId) {
    const all = AppState.get('passkeyAttempts');
    const cur = all[conversationId] ?? { count: 0, lockedUntil: null };
    cur.count++;
    if (cur.count >= CONFIG.PASSKEY_LOCKOUT_ATTEMPTS) {
      cur.lockedUntil = Date.now() + CONFIG.PASSKEY_LOCKOUT_DURATION_MS;
    }
    all[conversationId] = cur;
    AppState.set('passkeyAttempts', { ...all });
    return cur;
  },

  resetAttempts(conversationId) {
    const all = AppState.get('passkeyAttempts');
    delete all[conversationId];
    AppState.set('passkeyAttempts', { ...all });
  },

  /** Zero-out every passkey and derived key from memory. */
  clearKeys() {
    const pk = AppState.get('passkeys');
    for (const k of Object.keys(pk)) { pk[k] = ''; delete pk[k]; }
    const dk = AppState.get('derivedKeys');
    for (const k of Object.keys(dk)) { dk[k] = null; delete dk[k]; }
    AppState.batch({
      passkeys: {},
      derivedKeys: {},
      passkeySalts: {},
      passkeyAttempts: {},
    });
  },
};


// ─────────────────────────────────────────────────────────────
//  SUPABASE SERVICE — Auth · DB · Storage · Realtime
// ─────────────────────────────────────────────────────────────
class _SupabaseService {
  constructor() {
    /** @type {import('@supabase/supabase-js').SupabaseClient|null} */
    this.client = null;
    /** @type {Map<string, any>} active channel subscriptions */
    this._channels = new Map();
  }

  // ═══════════════════════ INIT ═══════════════════════════

  init() {
    if (this.client) return this.client;
    this.client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return this.client;
  }

  /** Expose raw client for edge cases. */
  getClient() {
    return this.client;
  }

  // ═══════════════════════ AUTH ════════════════════════════

  async signUp(email, password, displayName) {
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
    return data;
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async signOut() {
    CryptoEngine.clearKeys();
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.unsubscribeAll();
    AppState.reset();
  }

  async getSession() {
    const { data: { session }, error } = await this.client.auth.getSession();
    if (error) throw error;
    return session;
  }

  async getUser() {
    const { data: { user }, error } = await this.client.auth.getUser();
    if (error) throw error;
    return user;
  }

  /**
   * @param {(event:string, session:object|null)=>void} cb
   * @returns {{ data: { subscription } }}
   */
  onAuthStateChange(cb) {
    return this.client.auth.onAuthStateChange((event, session) => cb(event, session));
  }

  // ═══════════════════════ PROFILES ═══════════════════════

  async getProfile(userId) {
    const { data, error } = await this.client
      .from('profiles').select('*').eq('id', userId).single();
    if (error) throw error;
    return data;
  }

  async updateProfile(userId, updates) {
    const { data, error } = await this.client
      .from('profiles').update(updates).eq('id', userId).select().single();
    if (error) throw error;
    return data;
  }

  async searchUsers(query) {
    const currentUser = AppState.get('user');
    // Sanitize for PostgREST ilike patterns — escape %, _, and \
    const sanitized = query.replace(/[%_\\]/g, '\\$&');
    let q = this.client
      .from('profiles')
      .select('id, display_name, email, avatar_url, status_message')
      .or(`display_name.ilike.%${sanitized}%,email.ilike.%${sanitized}%`)
      .limit(20);
    if (currentUser) q = q.neq('id', currentUser.id);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  }

  async deleteAccount(userId) {
    const { error } = await this.client.from('profiles').delete().eq('id', userId);
    if (error) throw error;
    await this.signOut();
  }

  // ═══════════════════════ AVATAR / STORAGE ═══════════════

  async uploadAvatar(userId, file) {
    const ext  = file.name.split('.').pop();
    const path = `${userId}/avatar.${ext}`;

    const { error: upErr } = await this.client.storage
      .from('avatars').upload(path, file, { upsert: true });
    if (upErr) throw upErr;

    const { data: { publicUrl } } = this.client.storage
      .from('avatars').getPublicUrl(path);

    await this.updateProfile(userId, { avatar_url: publicUrl });
    return publicUrl;
  }

  // ═══════════════════════ CONTACTS ═══════════════════════

  async getContacts(userId) {
    const { data, error } = await this.client
      .from('contacts')
      .select(`
        *,
        contact:profiles!contacts_contact_id_fkey(
          id, display_name, email, avatar_url, status_message
        )
      `)
      .eq('user_id', userId)
      .eq('status', 'accepted');
    if (error) throw error;
    return data ?? [];
  }

  async getContactRequests(userId) {
    const { data, error } = await this.client
      .from('contacts')
      .select(`
        *,
        requester:profiles!contacts_user_id_fkey(
          id, display_name, email, avatar_url
        )
      `)
      .eq('contact_id', userId)
      .eq('status', 'pending');
    if (error) throw error;
    return data ?? [];
  }

  async sendContactRequest(userId, contactId) {
    const { data, error } = await this.client
      .from('contacts')
      .insert({ user_id: userId, contact_id: contactId, status: 'pending' })
      .select().single();
    if (error) throw error;
    return data;
  }

  async acceptContactRequest(requestId, userId, contactId) {
    // Flip existing row to accepted
    const { error: e1 } = await this.client
      .from('contacts').update({ status: 'accepted' }).eq('id', requestId);
    if (e1) throw e1;
    // Create reciprocal row
    const { error: e2 } = await this.client
      .from('contacts')
      .insert({ user_id: userId, contact_id: contactId, status: 'accepted' });
    if (e2) throw e2;
  }

  async declineContactRequest(requestId) {
    const { error } = await this.client.from('contacts').delete().eq('id', requestId);
    if (error) throw error;
  }

  async removeContact(userId, contactId) {
    const { error } = await this.client
      .from('contacts')
      .delete()
      .or(
        `and(user_id.eq.${userId},contact_id.eq.${contactId}),` +
        `and(user_id.eq.${contactId},contact_id.eq.${userId})`
      );
    if (error) throw error;
  }

  // ═══════════════════════ BLOCKED USERS ══════════════════

  async blockUser(userId, blockedId) {
    const { error } = await this.client
      .from('blocked_users')
      .insert({ user_id: userId, blocked_user_id: blockedId });
    if (error) throw error;
  }

  async unblockUser(userId, blockedId) {
    const { error } = await this.client
      .from('blocked_users')
      .delete()
      .eq('user_id', userId)
      .eq('blocked_user_id', blockedId);
    if (error) throw error;
  }

  async getBlockedUsers(userId) {
    const { data, error } = await this.client
      .from('blocked_users')
      .select(`
        *,
        blocked:profiles!blocked_users_blocked_user_id_fkey(
          id, display_name, email, avatar_url
        )
      `)
      .eq('user_id', userId);
    if (error) throw error;
    return data ?? [];
  }

  // ═══════════════════════ CONVERSATIONS ══════════════════

  async getConversations(userId) {
    const { data, error } = await this.client
      .from('conversation_participants')
      .select(`
        conversation_id,
        conversation:conversations(
          id, created_at, updated_at, encryption_salt,
          participants:conversation_participants(
            user_id,
            profile:profiles(id, display_name, email, avatar_url, status_message)
          )
        )
      `)
      .eq('user_id', userId);
    if (error) throw error;

    // Flatten and dedupe
    const convs = (data ?? [])
      .map(d => d.conversation)
      .filter(Boolean);

    // Sort by most-recently-updated
    convs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return convs;
  }

  async getOrCreateConversation(userId, otherUserId) {
    const { data, error } = await this.client
      .rpc('get_or_create_conversation', { user_a: userId, user_b: otherUserId });
    if (error) throw error;
    return data;
  }

  async deleteConversation(conversationId, userId) {
    const { error } = await this.client
      .from('conversation_participants')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);
    if (error) throw error;
  }

  async getConversationSalt(conversationId) {
    const { data, error } = await this.client
      .from('conversations')
      .select('encryption_salt')
      .eq('id', conversationId)
      .single();
    if (error) throw error;
    return data?.encryption_salt ?? null;
  }

  // ═══════════════════════ MESSAGES ═══════════════════════

  async getMessages(conversationId, { limit = CONFIG.MESSAGE_PAGE_SIZE, before = null } = {}) {
    let q = this.client
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) q = q.lt('created_at', before);

    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).reverse();          // oldest-first for rendering
  }

  async sendMessage(conversationId, userId, {
    ciphertext,
    iv,
    idempotencyKey,
    replyToId = null,
    messageType = 'text',
    fileMetadata = null,
  }) {
    const { data, error } = await this.client
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userId,
        ciphertext,
        iv,
        idempotency_key: idempotencyKey,
        reply_to_id: replyToId,
        message_type: messageType,
        file_metadata: fileMetadata,
        status: 'sent',
      })
      .select().single();
    if (error) throw error;

    // Bump conversation timestamp (non-critical — don't fail the send)
    try {
      await this.client
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);
    } catch (err) {
      console.warn('[SupabaseService] conversation timestamp bump failed:', err);
    }

    return data;
  }

  /**
   * Delete a message — "for me" hides it, "for everyone" tombstones it.
   */
  async deleteMessage(messageId, userId, forEveryone = false) {
    if (forEveryone) {
      const { error } = await this.client
        .from('messages')
        .update({
          ciphertext: null,
          iv: null,
          deleted_at: new Date().toISOString(),
          deleted_by: userId,
          status: 'deleted',
        })
        .eq('id', messageId)
        .eq('sender_id', userId);       // only sender can delete for everyone
      if (error) throw error;
    } else {
      // RPC handles array_append safely
      const { error } = await this.client.rpc('hide_message_for_user', {
        p_message_id: messageId,
        p_user_id: userId,
      });
      if (error) throw error;
    }
  }

  async updateMessageStatus(messageId, status) {
    const { error } = await this.client
      .from('messages').update({ status }).eq('id', messageId);
    if (error) throw error;
  }

  // ═══════════════════════ READ RECEIPTS ══════════════════

  async markMessagesRead(conversationId, userId) {
    const { error } = await this.client.rpc('mark_messages_read', {
      p_conversation_id: conversationId,
      p_user_id: userId,
    });
    if (error) throw error;
  }

  async getUnreadCount(conversationId, userId) {
    const { data, error } = await this.client.rpc('get_unread_count', {
      p_conversation_id: conversationId,
      p_user_id: userId,
    });
    if (error) throw error;
    return data ?? 0;
  }

  // ═══════════════════════ USER STATUS ════════════════════

  async setUserStatus(userId, status) {
    const { error } = await this.client
      .from('user_status')
      .upsert({ user_id: userId, status, last_seen: new Date().toISOString() });
    if (error) throw error;
  }

  async getUserStatuses(userIds) {
    if (!userIds.length) return [];
    const { data, error } = await this.client
      .from('user_status').select('*').in('user_id', userIds);
    if (error) throw error;
    return data ?? [];
  }

  // ═══════════════════════ FILE UPLOAD ════════════════════

  async uploadEncryptedFile(conversationId, fileName, encryptedData) {
    const path = `${conversationId}/${CryptoEngine.generateId()}_${fileName}`;
    const { error } = await this.client.storage
      .from('encrypted-files')
      .upload(path, encryptedData, { contentType: 'application/octet-stream', upsert: false });
    if (error) throw error;

    const { data: { publicUrl } } = this.client.storage
      .from('encrypted-files').getPublicUrl(path);
    return publicUrl;
  }

  async downloadEncryptedFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('File download failed');
    return res.arrayBuffer();
  }

  // ═══════════════════════ REALTIME ═══════════════════════

  /**
   * Subscribe to INSERT / UPDATE / DELETE on `messages`
   * for a specific conversation.
   */
  subscribeToMessages(conversationId, callback) {
    const key = `messages:${conversationId}`;
    this._removeChannel(key);

    const ch = this.client
      .channel(key)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, payload => callback(payload))
      .subscribe();

    this._channels.set(key, ch);
    return ch;
  }

  /**
   * Subscribe to any new messages across **all** conversations
   * (used for unread badges & notification triggers).
   */
  subscribeToAllMessages(userId, callback) {
    const key = `all-messages:${userId}`;
    this._removeChannel(key);

    const ch = this.client
      .channel(key)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      }, payload => callback(payload))
      .subscribe();

    this._channels.set(key, ch);
    return ch;
  }

  /**
   * Subscribe to contact-request changes aimed at this user.
   */
  subscribeToContacts(userId, callback) {
    const key = `contacts:${userId}`;
    this._removeChannel(key);

    const ch = this.client
      .channel(key)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'contacts',
        filter: `contact_id=eq.${userId}`,
      }, payload => callback(payload))
      .subscribe();

    this._channels.set(key, ch);
    return ch;
  }

  /**
   * Presence channel for a conversation (online + typing).
   */
  subscribeToPresence(conversationId, userId) {
    const key = `presence:${conversationId}`;
    this._removeChannel(key);

    const ch = this.client.channel(key, {
      config: { presence: { key: userId } },
    });

    ch.on('presence', { event: 'sync' }, () => {
      eventBus.emit('presence:sync', { conversationId, state: ch.presenceState() });
    })
    .on('presence', { event: 'join' }, ({ key: uid, newPresences }) => {
      eventBus.emit('presence:join', { conversationId, userId: uid, presences: newPresences });
    })
    .on('presence', { event: 'leave' }, ({ key: uid, leftPresences }) => {
      eventBus.emit('presence:leave', { conversationId, userId: uid, presences: leftPresences });
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({ online_at: new Date().toISOString(), typing: false });
      }
    });

    this._channels.set(key, ch);
    return ch;
  }

  async broadcastTyping(conversationId, isTyping) {
    const ch = this._channels.get(`presence:${conversationId}`);
    if (!ch) return;
    await ch.track({ online_at: new Date().toISOString(), typing: isTyping });
  }

  // ── Channel housekeeping ──

  unsubscribe(key) {
    this._removeChannel(key);
  }

  unsubscribeAll() {
    for (const [, ch] of this._channels) {
      this.client.removeChannel(ch);
    }
    this._channels.clear();
  }

  /** @private */
  _removeChannel(key) {
    const existing = this._channels.get(key);
    if (existing) {
      this.client.removeChannel(existing);
      this._channels.delete(key);
    }
  }
}

export const SupabaseService = new _SupabaseService();


// ─────────────────────────────────────────────────────────────
//  UTILS — Shared pure helpers
// ─────────────────────────────────────────────────────────────
export const Utils = {

  // ── Timing ──

  debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },

  throttle(fn, ms) {
    let last = 0;
    return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } };
  },

  // ── Date / time formatting ──

  timeAgo(ts) {
    const diff = Date.now() - new Date(ts).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 30)  return 'just now';
    if (s < 60)  return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7)   return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  },

  formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  formatDate(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest  = new Date(today); yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString())  return 'Yesterday';
    const opts = { weekday: 'long', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  },

  // ── Validation ──

  validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  /**
   * @returns {{ valid:boolean, checks:{ length, upper, lower, number, special } }}
   */
  validatePassword(pw) {
    const c = {
      length:  pw.length >= 8,
      upper:   /[A-Z]/.test(pw),
      lower:   /[a-z]/.test(pw),
      number:  /[0-9]/.test(pw),
      special: /[^a-zA-Z0-9]/.test(pw),
    };
    return { valid: Object.values(c).every(Boolean), checks: c };
  },

  // ── Sanitisation ──

  sanitizeInput(text) {
    if (!text) return '';
    return text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
  },

  /** Naive URL detector (returns array of URLs). */
  extractLinks(text) {
    return text.match(/(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g) ?? [];
  },

  // ── Data helpers ──

  chunkData(data, max = CONFIG.MESSAGE_CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < data.length; i += max) chunks.push(data.slice(i, i + max));
    return chunks;
  },

  /** Deterministic HSL colour from string (for default avatars). */
  stringToColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
  },

  getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  },

  /**
   * Generate a short human-readable ID (for display, not crypto).
   */
  shortId() {
    return Math.random().toString(36).slice(2, 8);
  },
};

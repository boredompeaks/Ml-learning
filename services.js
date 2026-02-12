/**
 * ═══════════════════════════════════════════════════════════════════════
 *  SecureChat — services.js
 *  Service Layer: RealtimeManager · NotificationService
 *                 ConnectivityManager
 *  ES6 Module — imports foundation from core.js
 *
 *  This file is the bridge between raw Supabase data/networking and
 *  the UI layer (app.js). Every outbound network call is wrapped in
 *  try/catch. Timers, subscriptions, and event listeners are tracked
 *  for deterministic cleanup (zero memory leaks).
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  CONFIG,
  eventBus,
  AppState,
  CryptoEngine,
  SupabaseService,
  Utils,
} from './core.js';


// ─────────────────────────────────────────────────────────────
//  REALTIME MANAGER
//  Subscriptions · Presence · Typing Indicators
// ─────────────────────────────────────────────────────────────
class _RealtimeManager {
  constructor() {
    /** @type {string|null} currently viewed conversation */
    this._activeConversationId = null;

    /** @type {Map<string, number>} userId → typing-expire timeout */
    this._typingExpireTimers = new Map();

    /** @type {number|null} debounce handle for outbound typing */
    this._typingBroadcastTimer = null;

    /** @type {boolean} are we currently broadcasting "typing"? */
    this._isTypingBroadcast = false;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {string|null} */
    this._userId = null;

    /** @type {Function[]} unsub handles for internal eventBus listeners */
    this._unsubs = [];
  }

  // ═══════════════════════ LIFECYCLE ═════════════════════════

  /**
   * Boot all global (non-conversation-specific) subscriptions.
   * Call once after successful authentication.
   * @param {string} userId
   */
  init(userId) {
    if (this._initialized) return;
    this._userId = userId;
    this._initialized = true;

    try {
      this._subscribeAllMessages(userId);
    } catch (err) {
      console.error('[RealtimeManager] _subscribeAllMessages failed:', err);
    }

    try {
      this._subscribeContacts(userId);
    } catch (err) {
      console.error('[RealtimeManager] _subscribeContacts failed:', err);
    }

    this._setUserOnline(userId);
    this._bindInternalEvents();

    console.log('[RealtimeManager] Initialized for user:', userId);
  }

  /**
   * Tear down every subscription and timer.
   */
  cleanup() {
    try {
      if (this._userId) {
        this._setUserOffline(this._userId);
      }
    } catch (err) {
      console.warn('[RealtimeManager] cleanup: offline status error:', err);
    }

    this._clearAllTypingTimers();

    // Remove internal eventBus listeners
    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) { /* already removed */ }
    }
    this._unsubs = [];

    try {
      SupabaseService.unsubscribeAll();
    } catch (err) {
      console.warn('[RealtimeManager] cleanup: unsubscribeAll error:', err);
    }

    this._activeConversationId = null;
    this._initialized = false;
    this._userId = null;

    console.log('[RealtimeManager] Cleaned up');
  }

  // ═══════════════════════ CONVERSATION SUBSCRIPTION ════════

  /**
   * Subscribe to messages + presence for the active conversation.
   * Automatically unsubs from previous conversation.
   * @param {string} conversationId
   */
  async enterConversation(conversationId) {
    try {
      // Leave previous conversation if different
      if (
        this._activeConversationId &&
        this._activeConversationId !== conversationId
      ) {
        await this.leaveConversation(this._activeConversationId);
      }

      this._activeConversationId = conversationId;
      AppState.set('activeConversationId', conversationId);

      // ── Message channel ──
      try {
        SupabaseService.subscribeToMessages(conversationId, (payload) => {
          this._handleMessagePayload(payload);
        });
      } catch (err) {
        console.error('[RealtimeManager] subscribeToMessages failed:', err);
      }

      // ── Presence channel (online + typing) ──
      if (this._userId) {
        try {
          SupabaseService.subscribeToPresence(conversationId, this._userId);
        } catch (err) {
          console.error('[RealtimeManager] subscribeToPresence failed:', err);
        }
      }

      // ── Mark existing messages as read ──
      if (this._userId) {
        try {
          await SupabaseService.markMessagesRead(conversationId, this._userId);
          this._updateUnreadCount(conversationId, 0);
        } catch (err) {
          console.warn('[RealtimeManager] markMessagesRead failed:', err);
        }
      }

      eventBus.emit('conversation:entered', { conversationId });
    } catch (err) {
      console.error('[RealtimeManager] enterConversation failed:', err);
      eventBus.emit('error', {
        source: 'realtime',
        message: 'Failed to join conversation',
        error: err,
      });
    }
  }

  /**
   * Unsub from a conversation's channels.
   * @param {string} conversationId
   */
  async leaveConversation(conversationId) {
    // Stop typing if active
    if (this._isTypingBroadcast) {
      try {
        await this.stopTyping(conversationId);
      } catch (err) {
        console.warn('[RealtimeManager] stopTyping on leave failed:', err);
      }
    }

    try {
      SupabaseService.unsubscribe(`messages:${conversationId}`);
    } catch (err) {
      console.warn('[RealtimeManager] unsub messages channel error:', err);
    }

    try {
      SupabaseService.unsubscribe(`presence:${conversationId}`);
    } catch (err) {
      console.warn('[RealtimeManager] unsub presence channel error:', err);
    }

    this._clearAllTypingTimers();

    if (this._activeConversationId === conversationId) {
      this._activeConversationId = null;
      AppState.set('activeConversationId', null);
    }

    eventBus.emit('conversation:left', { conversationId });
  }

  // ═══════════════════════ TYPING INDICATORS ════════════════

  /**
   * Call on every keystroke in the message input.
   * Debounces the actual broadcast.
   * @param {string} conversationId
   */
  startTyping(conversationId) {
    if (!conversationId || conversationId !== this._activeConversationId) return;

    // Begin broadcasting if not already
    if (!this._isTypingBroadcast) {
      this._isTypingBroadcast = true;
      this._broadcastTypingState(conversationId, true);
    }

    // Reset the auto-stop timer
    clearTimeout(this._typingBroadcastTimer);
    this._typingBroadcastTimer = setTimeout(() => {
      this.stopTyping(conversationId);
    }, CONFIG.TYPING_DEBOUNCE_MS);
  }

  /**
   * Explicitly stop typing broadcast.
   * @param {string} conversationId
   */
  async stopTyping(conversationId) {
    clearTimeout(this._typingBroadcastTimer);
    this._typingBroadcastTimer = null;
    this._isTypingBroadcast = false;

    try {
      await this._broadcastTypingState(conversationId, false);
    } catch (err) {
      console.warn('[RealtimeManager] stopTyping broadcast error:', err);
    }
  }

  // ═══════════════════════ HELPERS ══════════════════════════

  /** Is a given conversation currently active and visible? */
  isConversationActive(conversationId) {
    return (
      this._activeConversationId === conversationId &&
      document.visibilityState === 'visible'
    );
  }

  /** @returns {string|null} */
  getActiveConversationId() {
    return this._activeConversationId;
  }

  /**
   * Re-subscribe to the active conversation after reconnect.
   * Called by ConnectivityManager.
   */
  async resubscribeActive() {
    const convId = this._activeConversationId;
    if (!convId) return;

    try {
      // Tear down stale channels then rebuild
      SupabaseService.unsubscribe(`messages:${convId}`);
      SupabaseService.unsubscribe(`presence:${convId}`);

      SupabaseService.subscribeToMessages(convId, (payload) => {
        this._handleMessagePayload(payload);
      });

      if (this._userId) {
        SupabaseService.subscribeToPresence(convId, this._userId);
      }

      console.log('[RealtimeManager] Re-subscribed to active conversation:', convId);
    } catch (err) {
      console.error('[RealtimeManager] resubscribeActive error:', err);
    }
  }

  /**
   * Re-initialise global subscriptions (all-messages, contacts).
   * Called by ConnectivityManager on reconnect.
   */
  resubscribeGlobal() {
    if (!this._userId) return;

    try {
      SupabaseService.unsubscribe(`all-messages:${this._userId}`);
    } catch (_) { /* ok */ }
    try {
      SupabaseService.unsubscribe(`contacts:${this._userId}`);
    } catch (_) { /* ok */ }

    try {
      this._subscribeAllMessages(this._userId);
    } catch (err) {
      console.error('[RealtimeManager] resubscribeGlobal all-messages error:', err);
    }
    try {
      this._subscribeContacts(this._userId);
    } catch (err) {
      console.error('[RealtimeManager] resubscribeGlobal contacts error:', err);
    }

    console.log('[RealtimeManager] Re-subscribed global channels');
  }

  // ═══════════════════════ PRIVATE — SUBSCRIPTIONS ══════════

  /** @private */
  _subscribeAllMessages(userId) {
    SupabaseService.subscribeToAllMessages(userId, (payload) => {
      this._handleGlobalMessageInsert(payload);
    });
  }

  /** @private */
  _subscribeContacts(userId) {
    SupabaseService.subscribeToContacts(userId, (payload) => {
      this._handleContactPayload(payload);
    });
  }

  /** @private */
  _bindInternalEvents() {
    // Presence sync → extract online users + typing state
    this._unsubs.push(
      eventBus.on('presence:sync', ({ conversationId, state }) => {
        this._processPresenceState(conversationId, state);
      })
    );

    // Presence join
    this._unsubs.push(
      eventBus.on('presence:join', ({ conversationId, userId: uid }) => {
        if (uid === this._userId) return;
        try {
          const online = AppState.get('onlineUsers');
          online.add(uid);
          AppState.set('onlineUsers', new Set(online));
          eventBus.emit('user:online', { userId: uid, conversationId });
        } catch (err) {
          console.warn('[RealtimeManager] presence:join handler error:', err);
        }
      })
    );

    // Presence leave
    this._unsubs.push(
      eventBus.on('presence:leave', ({ conversationId, userId: uid }) => {
        if (uid === this._userId) return;
        try {
          const online = AppState.get('onlineUsers');
          online.delete(uid);
          AppState.set('onlineUsers', new Set(online));

          // Remove from typing
          const typing = AppState.get('typingUsers')[conversationId];
          if (typing) {
            typing.delete(uid);
            AppState.merge('typingUsers', conversationId, new Set(typing));
            eventBus.emit('typing:update', { conversationId, typingUsers: new Set(typing) });
          }

          eventBus.emit('user:offline', { userId: uid, conversationId });
        } catch (err) {
          console.warn('[RealtimeManager] presence:leave handler error:', err);
        }
      })
    );
  }

  // ═══════════════════════ PRIVATE — MESSAGE HANDLERS ═══════

  /**
   * Handle INSERT / UPDATE / DELETE on messages for active conversation.
   * @private
   */
  _handleMessagePayload(payload) {
    try {
      const { eventType, new: newRow, old: oldRow } = payload;

      switch (eventType) {
        case 'INSERT':
          this._onMessageInsert(newRow);
          break;
        case 'UPDATE':
          this._onMessageUpdate(newRow, oldRow);
          break;
        case 'DELETE':
          this._onMessageDelete(oldRow);
          break;
        default:
          console.warn('[RealtimeManager] Unknown message event type:', eventType);
      }
    } catch (err) {
      console.error('[RealtimeManager] _handleMessagePayload error:', err);
    }
  }

  /** @private */
  _onMessageInsert(msg) {
    if (!msg) return;

    const convId = msg.conversation_id;

    // Own message → confirm optimistic insert
    if (msg.sender_id === this._userId) {
      eventBus.emit('message:sent:confirmed', { message: msg });
      return;
    }

    // Add to local state
    const messages = AppState.get('messages')[convId] ?? [];

    // Deduplicate by idempotency key
    if (msg.idempotency_key) {
      const dup = messages.some(
        (m) => m.idempotency_key && m.idempotency_key === msg.idempotency_key
      );
      if (dup) return;
    }

    // Deduplicate by ID
    if (messages.some((m) => m.id === msg.id)) return;

    messages.push(msg);
    AppState.merge('messages', convId, [...messages]);

    // Auto-mark read if conversation is active and visible
    if (
      convId === this._activeConversationId &&
      document.visibilityState === 'visible'
    ) {
      SupabaseService.markMessagesRead(convId, this._userId).catch((err) => {
        console.warn('[RealtimeManager] auto-markRead error:', err);
      });
    }

    eventBus.emit('message:received', { message: msg, conversationId: convId });
  }

  /** @private */
  _onMessageUpdate(newMsg, oldMsg) {
    if (!newMsg) return;

    const convId = newMsg.conversation_id;
    const messages = AppState.get('messages')[convId] ?? [];
    const idx = messages.findIndex((m) => m.id === newMsg.id);

    if (idx !== -1) {
      messages[idx] = { ...messages[idx], ...newMsg };
      AppState.merge('messages', convId, [...messages]);
    }

    eventBus.emit('message:updated', {
      message: newMsg,
      old: oldMsg,
      conversationId: convId,
    });
  }

  /** @private */
  _onMessageDelete(oldMsg) {
    if (!oldMsg) return;

    const convId = oldMsg.conversation_id;
    const messages = AppState.get('messages')[convId] ?? [];
    const filtered = messages.filter((m) => m.id !== oldMsg.id);
    AppState.merge('messages', convId, filtered);

    eventBus.emit('message:deleted', {
      messageId: oldMsg.id,
      conversationId: convId,
    });
  }

  /**
   * Handle a new message from ANY conversation (global sub).
   * Used for unread counts and notifications.
   * @private
   */
  _handleGlobalMessageInsert(payload) {
    try {
      const msg = payload.new;
      if (!msg || msg.sender_id === this._userId) return;

      const convId = msg.conversation_id;

      // If NOT the active & visible conversation → increment unread
      if (
        convId !== this._activeConversationId ||
        document.visibilityState !== 'visible'
      ) {
        const counts = AppState.get('unreadCounts');
        counts[convId] = (counts[convId] ?? 0) + 1;
        AppState.set('unreadCounts', { ...counts });

        // Recalculate total
        const total = Object.values(AppState.get('unreadCounts')).reduce(
          (a, b) => a + b,
          0
        );
        AppState.set('totalUnread', total);

        // Trigger notification
        eventBus.emit('notification:message', {
          message: msg,
          conversationId: convId,
        });
      }

      // Always emit for conversation list refresh (reorder, preview)
      eventBus.emit('conversations:updated', { conversationId: convId });
    } catch (err) {
      console.error('[RealtimeManager] _handleGlobalMessageInsert error:', err);
    }
  }

  // ═══════════════════════ PRIVATE — CONTACT HANDLER ════════

  /** @private */
  _handleContactPayload(payload) {
    try {
      const { eventType, new: newRow } = payload;

      if (eventType === 'INSERT' && newRow?.status === 'pending') {
        eventBus.emit('contact:request:received', { request: newRow });
        eventBus.emit('notification:contact', { type: 'request', data: newRow });
      } else if (eventType === 'UPDATE' && newRow?.status === 'accepted') {
        eventBus.emit('contact:request:accepted', { contact: newRow });
      } else if (eventType === 'DELETE') {
        eventBus.emit('contact:removed', { data: payload.old });
      }

      // Trigger contacts list refresh
      eventBus.emit('contacts:refresh');
    } catch (err) {
      console.error('[RealtimeManager] _handleContactPayload error:', err);
    }
  }

  // ═══════════════════════ PRIVATE — PRESENCE PROCESSING ════

  /**
   * Process the full presence state for a conversation.
   * Extracts online set and per-user typing flags.
   * @private
   */
  _processPresenceState(conversationId, state) {
    try {
      const onlineUsers = AppState.get('onlineUsers');
      const typingSet = new Set();

      for (const [uid, presences] of Object.entries(state)) {
        if (uid === this._userId) continue;

        // User is online — they're in the presence channel
        onlineUsers.add(uid);

        // Latest presence payload carries the typing flag
        const latest = presences[presences.length - 1];
        if (latest?.typing) {
          typingSet.add(uid);
          this._setTypingExpireTimer(conversationId, uid);
        } else {
          this._clearTypingExpireTimer(uid);
        }
      }

      AppState.set('onlineUsers', new Set(onlineUsers));
      AppState.merge('typingUsers', conversationId, typingSet);

      eventBus.emit('typing:update', { conversationId, typingUsers: typingSet });
      eventBus.emit('presence:updated', { conversationId, onlineUsers });
    } catch (err) {
      console.error('[RealtimeManager] _processPresenceState error:', err);
    }
  }

  /**
   * Set a timeout to auto-clear a remote user's typing state
   * if no fresh presence update arrives in time.
   * @private
   */
  _setTypingExpireTimer(conversationId, userId) {
    this._clearTypingExpireTimer(userId);

    const timer = setTimeout(() => {
      try {
        const typing = AppState.get('typingUsers')[conversationId];
        if (typing) {
          typing.delete(userId);
          AppState.merge('typingUsers', conversationId, new Set(typing));
          eventBus.emit('typing:update', {
            conversationId,
            typingUsers: new Set(typing),
          });
        }
      } catch (err) {
        console.warn('[RealtimeManager] typing expire cleanup error:', err);
      }
      this._typingExpireTimers.delete(userId);
    }, CONFIG.TYPING_TIMEOUT_MS);

    this._typingExpireTimers.set(userId, timer);
  }

  /** @private */
  _clearTypingExpireTimer(userId) {
    const existing = this._typingExpireTimers.get(userId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this._typingExpireTimers.delete(userId);
    }
  }

  /** @private */
  _clearAllTypingTimers() {
    for (const [, timer] of this._typingExpireTimers) {
      clearTimeout(timer);
    }
    this._typingExpireTimers.clear();

    clearTimeout(this._typingBroadcastTimer);
    this._typingBroadcastTimer = null;
    this._isTypingBroadcast = false;
  }

  /** @private */
  async _broadcastTypingState(conversationId, isTyping) {
    try {
      await SupabaseService.broadcastTyping(conversationId, isTyping);
    } catch (err) {
      console.warn('[RealtimeManager] _broadcastTypingState error:', err);
    }
  }

  // ═══════════════════════ PRIVATE — USER STATUS ════════════

  /** @private */
  async _setUserOnline(userId) {
    try {
      await SupabaseService.setUserStatus(userId, 'online');
    } catch (err) {
      console.warn('[RealtimeManager] setUserOnline error:', err);
    }
  }

  /** @private */
  async _setUserOffline(userId) {
    try {
      await SupabaseService.setUserStatus(userId, 'offline');
    } catch (err) {
      console.warn('[RealtimeManager] setUserOffline error:', err);
    }
  }

  // ═══════════════════════ PRIVATE — UNREAD HELPER ══════════

  /** @private */
  _updateUnreadCount(conversationId, count) {
    const counts = AppState.get('unreadCounts');
    counts[conversationId] = count;
    AppState.set('unreadCounts', { ...counts });

    const total = Object.values(AppState.get('unreadCounts')).reduce(
      (a, b) => a + b,
      0
    );
    AppState.set('totalUnread', total);
  }
}

export const RealtimeManager = new _RealtimeManager();


// ─────────────────────────────────────────────────────────────
//  NOTIFICATION SERVICE
//  Desktop Push · Sound Ping · Tab Title Badge · In-App Toast
// ─────────────────────────────────────────────────────────────
class _NotificationService {
  constructor() {
    /** @type {AudioContext|null} lazy-initialised */
    this._audioCtx = null;

    /** @type {string} Notification.permission mirror */
    this._permission = 'default';

    /** @type {boolean} */
    this._soundEnabled = true;
    /** @type {boolean} */
    this._desktopEnabled = true;

    /** @type {string} stashed original title */
    this._originalTitle = 'SecureChat';

    /** @type {number|null} flash interval handle */
    this._flashInterval = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {HTMLElement|null} toast container ref */
    this._toastContainer = null;

    /** @type {Function[]} eventBus unsub handles */
    this._unsubs = [];
  }

  // ═══════════════════════ LIFECYCLE ═════════════════════════

  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._originalTitle = document.title || 'SecureChat';

    // ── Load persisted preferences ──
    try {
      const s = localStorage.getItem('securechat_sound');
      if (s !== null) this._soundEnabled = s !== 'false';
    } catch (_) { /* storage unavailable */ }

    try {
      const d = localStorage.getItem('securechat_desktop_notif');
      if (d !== null) this._desktopEnabled = d !== 'false';
    } catch (_) { /* storage unavailable */ }

    // ── Check current Notification permission ──
    if ('Notification' in window) {
      this._permission = Notification.permission;
    }

    // ── Ensure toast container DOM node ──
    this._ensureToastContainer();

    // ── Bind reactive events ──
    this._bindEvents();

    console.log(
      '[NotificationService] Initialized — permission:',
      this._permission,
      '| sound:',
      this._soundEnabled,
      '| desktop:',
      this._desktopEnabled
    );
  }

  /**
   * Request browser notification permission.
   * **Must** be called from a user-gesture handler (click, tap).
   * @returns {Promise<string>} 'granted' | 'denied' | 'default'
   */
  async requestPermission() {
    if (!('Notification' in window)) {
      console.warn('[NotificationService] Notification API not supported');
      return 'denied';
    }

    try {
      this._permission = await Notification.requestPermission();
      return this._permission;
    } catch (err) {
      console.error('[NotificationService] requestPermission error:', err);
      return 'denied';
    }
  }

  cleanup() {
    this._stopFlashing();

    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) { /* already removed */ }
    }
    this._unsubs = [];

    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch (_) { /* ok */ }
      this._audioCtx = null;
    }

    document.title = this._originalTitle;
    this._initialized = false;

    console.log('[NotificationService] Cleaned up');
  }

  // ═══════════════════════ DESKTOP NOTIFICATIONS ════════════

  /**
   * Show a browser desktop notification.
   * Silently no-ops if permission denied, tab focused, or disabled.
   *
   * @param {string} title
   * @param {string} body
   * @param {Object} [options]
   * @param {string}   [options.tag]     dedupe key
   * @param {string}   [options.icon]    notification icon URL
   * @param {Function} [options.onClick] click handler
   */
  showDesktopNotification(title, body, options = {}) {
    if (!this._desktopEnabled) return;
    if (this._permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;

    try {
      const notif = new Notification(title, {
        body,
        icon: options.icon || undefined,
        badge: options.icon || undefined,
        tag: options.tag || `securechat-${Date.now()}`,
        silent: false,
        requireInteraction: false,
      });

      notif.onclick = () => {
        try {
          window.focus();
          notif.close();
          if (typeof options.onClick === 'function') {
            options.onClick();
          }
        } catch (err) {
          console.warn('[NotificationService] notif.onclick error:', err);
        }
      };

      // Auto-close after 6 seconds
      setTimeout(() => {
        try { notif.close(); } catch (_) { /* already closed */ }
      }, 6_000);
    } catch (err) {
      console.warn('[NotificationService] showDesktopNotification error:', err);
    }
  }

  // ═══════════════════════ SOUND ════════════════════════════

  /**
   * Play a subtle two-tone notification ping.
   * Synthesised via Web Audio API — no external file required.
   * Safe to call at any time; silently no-ops if sound disabled
   * or browser blocks audio (autoplay policy).
   */
  async playSound() {
    if (!this._soundEnabled) return;

    try {
      // Lazy-init AudioContext (must follow a user gesture at some point)
      if (!this._audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this._audioCtx = new Ctor();
      }

      // Resume if suspended (Chrome autoplay policy)
      if (this._audioCtx.state === 'suspended') {
        await this._audioCtx.resume();
      }

      const now = this._audioCtx.currentTime;

      // ── Oscillator 1 — primary tone ──
      const osc1 = this._audioCtx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.exponentialRampToValueAtTime(660, now + 0.12);

      // ── Oscillator 2 — harmonic shimmer ──
      const osc2 = this._audioCtx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1318, now + 0.04);
      osc2.frequency.exponentialRampToValueAtTime(880, now + 0.18);

      // ── Gain envelope ──
      const gain = this._audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this._audioCtx.destination);

      osc1.start(now);
      osc2.start(now + 0.04);
      osc1.stop(now + 0.35);
      osc2.stop(now + 0.35);
    } catch (err) {
      console.warn('[NotificationService] playSound error:', err);
    }
  }

  // ═══════════════════════ TAB TITLE BADGE ══════════════════

  /**
   * Update `document.title` to include an unread count badge.
   * @param {number} count
   */
  updateTabTitle(count) {
    try {
      if (count > 0) {
        document.title = `(${count}) ${this._originalTitle}`;
        if (document.visibilityState !== 'visible') {
          this._startFlashing();
        }
      } else {
        document.title = this._originalTitle;
        this._stopFlashing();
      }
    } catch (err) {
      console.warn('[NotificationService] updateTabTitle error:', err);
    }
  }

  /** @private */
  _startFlashing() {
    if (this._flashInterval) return;

    let toggle = true;
    this._flashInterval = setInterval(() => {
      try {
        const count = AppState.get('totalUnread') || 0;
        if (count === 0 || document.visibilityState === 'visible') {
          this._stopFlashing();
          return;
        }
        document.title = toggle
          ? `(${count}) ${this._originalTitle}`
          : '\u{1F4AC} New Message!';
        toggle = !toggle;
      } catch (_) { /* ignore */ }
    }, 1_200);
  }

  /** @private */
  _stopFlashing() {
    if (this._flashInterval) {
      clearInterval(this._flashInterval);
      this._flashInterval = null;
    }
  }

  // ═══════════════════════ IN-APP TOAST ═════════════════════

  /**
   * Show an in-app toast notification.
   *
   * @param {string} message  — text content (safe — rendered via textContent)
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   * @param {number} [duration]  ms — pass 0 for persistent toast
   * @returns {HTMLElement|null} the toast DOM node
   */
  showToast(message, type = 'info', duration = CONFIG.TOAST_DURATION_MS) {
    try {
      this._ensureToastContainer();

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.setAttribute('role', 'alert');
      toast.setAttribute('aria-live', 'assertive');

      // ── Icon ──
      const iconMap = {
        info:    '\u{2139}\u{FE0F}',   // ℹ️
        success: '\u{2705}',            // ✅
        warning: '\u{26A0}\u{FE0F}',   // ⚠️
        error:   '\u{274C}',            // ❌
      };

      const iconSpan = document.createElement('span');
      iconSpan.className = 'toast-icon';
      iconSpan.textContent = iconMap[type] || iconMap.info;

      const textSpan = document.createElement('span');
      textSpan.className = 'toast-text';
      textSpan.textContent = message;

      const closeBtn = document.createElement('button');
      closeBtn.className = 'toast-close';
      closeBtn.textContent = '\u00D7'; // ×
      closeBtn.setAttribute('aria-label', 'Dismiss notification');
      closeBtn.addEventListener('click', () => this._dismissToast(toast));

      toast.appendChild(iconSpan);
      toast.appendChild(textSpan);
      toast.appendChild(closeBtn);

      this._toastContainer.appendChild(toast);

      // Trigger entrance animation on next frame
      requestAnimationFrame(() => {
        toast.classList.add('toast-enter');
      });

      // Auto-dismiss after duration (0 = persistent)
      if (duration > 0) {
        const timerId = setTimeout(() => this._dismissToast(toast), duration);
        toast._timerId = timerId;
      }

      return toast;
    } catch (err) {
      console.error('[NotificationService] showToast error:', err);
      return null;
    }
  }

  /** @private */
  _dismissToast(toast) {
    if (!toast || !toast.parentNode) return;

    // Clear auto-dismiss timer if still pending
    if (toast._timerId) {
      clearTimeout(toast._timerId);
      toast._timerId = null;
    }

    toast.classList.remove('toast-enter');
    toast.classList.add('toast-exit');

    const onEnd = () => {
      try { toast.remove(); } catch (_) { /* already removed */ }
    };

    toast.addEventListener('animationend', onEnd, { once: true });

    // Fallback if animationend never fires
    setTimeout(onEnd, 500);
  }

  /** @private */
  _ensureToastContainer() {
    if (this._toastContainer && document.body.contains(this._toastContainer)) {
      return;
    }
    this._toastContainer = document.getElementById('toast-container');
    if (!this._toastContainer) {
      this._toastContainer = document.createElement('div');
      this._toastContainer.id = 'toast-container';
      this._toastContainer.className = 'toast-container';
      this._toastContainer.setAttribute('aria-live', 'polite');
      this._toastContainer.setAttribute('aria-atomic', 'false');
      document.body.appendChild(this._toastContainer);
    }
  }

  // ═══════════════════════ PREFERENCES ══════════════════════

  /** Enable / disable notification sound. Persisted to localStorage. */
  setSoundEnabled(enabled) {
    this._soundEnabled = !!enabled;
    try { localStorage.setItem('securechat_sound', String(this._soundEnabled)); }
    catch (_) { /* storage unavailable */ }
  }

  /** Enable / disable desktop notifications. Persisted to localStorage. */
  setDesktopEnabled(enabled) {
    this._desktopEnabled = !!enabled;
    try { localStorage.setItem('securechat_desktop_notif', String(this._desktopEnabled)); }
    catch (_) { /* storage unavailable */ }
  }

  isSoundEnabled()   { return this._soundEnabled; }
  isDesktopEnabled() { return this._desktopEnabled; }
  getPermission()    { return this._permission; }

  // ═══════════════════════ PRIVATE — EVENT BINDINGS ═════════

  /** @private */
  _bindEvents() {
    // ── New message → desktop notif + sound + tab badge ──
    this._unsubs.push(
      eventBus.on('notification:message', async ({ message, conversationId }) => {
        try {
          // Resolve sender name for the notification title
          let senderName = 'Someone';
          const conversations = AppState.get('conversations') || [];
          const conv = conversations.find((c) => c.id === conversationId);

          if (conv?.participants) {
            const sender = conv.participants.find(
              (p) => p.user_id === message.sender_id
            );
            if (sender?.profile?.display_name) {
              senderName = sender.profile.display_name;
            }
          }

          this.showDesktopNotification(
            senderName,
            '\u{1F512} New encrypted message',
            {
              tag: `msg-${conversationId}`,
              onClick: () => {
                eventBus.emit('navigate:conversation', { conversationId });
              },
            }
          );

          await this.playSound();

          const total = AppState.get('totalUnread') || 0;
          this.updateTabTitle(total);
        } catch (err) {
          console.warn('[NotificationService] notification:message handler error:', err);
        }
      })
    );

    // ── Contact request → toast + sound ──
    this._unsubs.push(
      eventBus.on('notification:contact', async ({ type }) => {
        try {
          if (type === 'request') {
            this.showToast('New contact request received!', 'info');
            await this.playSound();
          }
        } catch (err) {
          console.warn('[NotificationService] notification:contact handler error:', err);
        }
      })
    );

    // ── Tab visibility → stop flashing when user returns ──
    const onVisibility = () => {
      try {
        if (document.visibilityState === 'visible') {
          this._stopFlashing();
          const total = AppState.get('totalUnread') || 0;
          this.updateTabTitle(total);
        }
      } catch (_) { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Track for removal (wrap as a pseudo-unsub)
    this._unsubs.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
    });

    // ── Reactive: totalUnread → update tab ──
    this._unsubs.push(
      AppState.watch('totalUnread', (total) => {
        this.updateTabTitle(total);
      })
    );
  }
}

export const NotificationService = new _NotificationService();


// ─────────────────────────────────────────────────────────────
//  CONNECTIVITY MANAGER
//  Online/Offline · Tab Visibility · Reconnection · Message Queue
//  Session Timeout · Heartbeat
// ─────────────────────────────────────────────────────────────
class _ConnectivityManager {
  constructor() {
    /** @type {'online'|'offline'|'reconnecting'} */
    this._status = 'online';

    /** @type {number|null} reconnect interval handle */
    this._reconnectInterval = null;

    /** @type {number|null} heartbeat interval handle */
    this._heartbeatInterval = null;

    /** @type {number} reconnect attempt counter */
    this._reconnectAttempts = 0;

    /** @type {number} max reconnect back-off (ms) */
    this._maxReconnectDelay = 30_000;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._tabVisible = true;

    /** @type {number|null} session inactivity timeout */
    this._sessionTimeout = null;

    /** @type {Object} bound handler refs for cleanup */
    this._handlers = {};

    /** @type {Function[]} eventBus unsub handles */
    this._unsubs = [];
  }

  // ═══════════════════════ LIFECYCLE ═════════════════════════

  init() {
    if (this._initialized) return;
    this._initialized = true;

    this._status = navigator.onLine ? 'online' : 'offline';
    this._tabVisible = document.visibilityState === 'visible';

    AppState.set(
      'connectionStatus',
      this._status === 'online' ? 'connected' : 'disconnected'
    );

    this._bindBrowserEvents();
    this._bindInternalEvents();
    this._startHeartbeat();
    this._resetSessionTimeout();

    console.log('[ConnectivityManager] Initialized — status:', this._status);
  }

  cleanup() {
    this._unbindBrowserEvents();

    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) { /* ok */ }
    }
    this._unsubs = [];

    this._stopReconnecting();
    this._stopHeartbeat();
    this._clearSessionTimeout();

    this._initialized = false;
    console.log('[ConnectivityManager] Cleaned up');
  }

  // ═══════════════════════ PUBLIC API ════════════════════════

  /** @returns {'online'|'offline'|'reconnecting'} */
  getStatus() {
    return this._status;
  }

  /** @returns {boolean} */
  isOnline() {
    return this._status === 'online';
  }

  /**
   * Queue a message payload for sending when back online.
   * @param {Object} messagePayload
   */
  queueMessage(messagePayload) {
    try {
      const queue = AppState.get('messageQueue') || [];
      queue.push({
        ...messagePayload,
        _queuedAt: Date.now(),
      });
      AppState.set('messageQueue', [...queue]);
      eventBus.emit('queue:updated', { count: queue.length });
    } catch (err) {
      console.error('[ConnectivityManager] queueMessage error:', err);
    }
  }

  /**
   * Flush queued messages — attempt to send each one.
   * Expired messages (> 5 min) are discarded.
   * @returns {Promise<{sent:number, failed:number, remaining:number}>}
   */
  async flushQueue() {
    const queue = AppState.get('messageQueue') || [];
    if (queue.length === 0) return { sent: 0, failed: 0, remaining: 0 };

    const EXPIRY_MS = 5 * 60 * 1000;
    let sent = 0;
    let failed = 0;
    const remaining = [];

    for (const msg of queue) {
      // Discard expired
      if (Date.now() - (msg._queuedAt || 0) > EXPIRY_MS) {
        failed++;
        eventBus.emit('message:queue:expired', { message: msg });
        continue;
      }

      try {
        await SupabaseService.sendMessage(msg.conversationId, msg.userId, {
          ciphertext:     msg.ciphertext,
          iv:             msg.iv,
          idempotencyKey: msg.idempotencyKey,
          replyToId:      msg.replyToId   || null,
          messageType:    msg.messageType  || 'text',
          fileMetadata:   msg.fileMetadata || null,
        });
        sent++;
      } catch (err) {
        console.warn('[ConnectivityManager] flushQueue send error:', err);
        remaining.push(msg);
        failed++;
      }
    }

    AppState.set('messageQueue', remaining);
    eventBus.emit('queue:flushed', { sent, failed, remaining: remaining.length });

    // User feedback
    if (sent > 0) {
      NotificationService.showToast(
        `${sent} queued message${sent > 1 ? 's' : ''} sent`,
        'success'
      );
    }
    if (remaining.length > 0) {
      NotificationService.showToast(
        `${remaining.length} message${remaining.length > 1 ? 's' : ''} still queued`,
        'warning'
      );
    }

    return { sent, failed, remaining: remaining.length };
  }

  /**
   * Force an immediate reconnection attempt.
   */
  async forceReconnect() {
    this._setStatus('reconnecting');
    try {
      await this._reconnect();
      this._setStatus('online');
      NotificationService.showToast('Reconnected!', 'success');
    } catch (err) {
      console.warn('[ConnectivityManager] forceReconnect failed:', err);
      this._startReconnecting();
    }
  }

  /**
   * Reset session inactivity timeout.
   * Call from any user-interaction handler.
   */
  resetSessionTimeout() {
    this._resetSessionTimeout();
  }

  // ═══════════════════════ PRIVATE — BROWSER EVENTS ═════════

  /** @private */
  _bindBrowserEvents() {
    this._handlers.online     = () => this._handleOnline();
    this._handlers.offline    = () => this._handleOffline();
    this._handlers.visibility = () => this._handleVisibilityChange();
    this._handlers.beforeUnload = (e) => this._handleBeforeUnload(e);

    // Throttled activity tracker for session timeout
    this._handlers.activity = Utils.throttle(() => {
      this._resetSessionTimeout();
    }, 30_000);

    window.addEventListener('online',  this._handlers.online);
    window.addEventListener('offline', this._handlers.offline);
    document.addEventListener('visibilitychange', this._handlers.visibility);
    window.addEventListener('beforeunload', this._handlers.beforeUnload);

    // User activity listeners
    document.addEventListener('mousedown',  this._handlers.activity);
    document.addEventListener('keydown',    this._handlers.activity);
    document.addEventListener('touchstart', this._handlers.activity, { passive: true });
    document.addEventListener('scroll',     this._handlers.activity, { passive: true });
  }

  /** @private */
  _unbindBrowserEvents() {
    window.removeEventListener('online',  this._handlers.online);
    window.removeEventListener('offline', this._handlers.offline);
    document.removeEventListener('visibilitychange', this._handlers.visibility);
    window.removeEventListener('beforeunload', this._handlers.beforeUnload);

    document.removeEventListener('mousedown',  this._handlers.activity);
    document.removeEventListener('keydown',    this._handlers.activity);
    document.removeEventListener('touchstart', this._handlers.activity);
    document.removeEventListener('scroll',     this._handlers.activity);
  }

  /** @private */
  _bindInternalEvents() {
    // Listen for reconnect request from RealtimeManager or other modules
    this._unsubs.push(
      eventBus.on('realtime:reconnect', async () => {
        try {
          RealtimeManager.resubscribeGlobal();
          await RealtimeManager.resubscribeActive();
        } catch (err) {
          console.warn('[ConnectivityManager] realtime:reconnect handler error:', err);
        }
      })
    );

    // Session expired → auto-logout
    this._unsubs.push(
      eventBus.on('session:expired', () => {
        try {
          SupabaseService.signOut().catch((err) => {
            console.warn('[ConnectivityManager] signOut on session:expired error:', err);
          });
        } catch (err) {
          console.error('[ConnectivityManager] session:expired handler error:', err);
        }
      })
    );

    // Session timeout → auto-logout
    this._unsubs.push(
      eventBus.on('session:timeout', () => {
        try {
          SupabaseService.signOut().catch((err) => {
            console.warn('[ConnectivityManager] signOut on session:timeout error:', err);
          });
        } catch (err) {
          console.error('[ConnectivityManager] session:timeout handler error:', err);
        }
      })
    );
  }

  // ═══════════════════════ PRIVATE — HANDLERS ═══════════════

  /** @private */
  async _handleOnline() {
    console.log('[ConnectivityManager] Browser online event');
    this._setStatus('reconnecting');

    try {
      await this._reconnect();
      this._setStatus('online');
      this._reconnectAttempts = 0;

      NotificationService.showToast('Connection restored', 'success');

      // Flush queued messages
      try {
        await this.flushQueue();
      } catch (err) {
        console.warn('[ConnectivityManager] flushQueue on online error:', err);
      }

      // Re-enter active conversation
      const activeConv = AppState.get('activeConversationId');
      if (activeConv) {
        eventBus.emit('conversation:reconnect', { conversationId: activeConv });
      }

      // Trigger data refreshes
      eventBus.emit('conversations:refresh');
      eventBus.emit('contacts:refresh');
    } catch (err) {
      console.error('[ConnectivityManager] _handleOnline reconnect failed:', err);
      this._startReconnecting();
    }
  }

  /** @private */
  _handleOffline() {
    console.log('[ConnectivityManager] Browser offline event');
    this._setStatus('offline');
    NotificationService.showToast(
      'You are offline. Messages will be queued.',
      'warning'
    );
  }

  /** @private */
  async _handleVisibilityChange() {
    const wasVisible = this._tabVisible;
    this._tabVisible = document.visibilityState === 'visible';

    try {
      if (this._tabVisible && !wasVisible) {
        // ── Tab became visible ──
        eventBus.emit('tab:visible');
        this._resetSessionTimeout();

        // Reconnect if we fell offline while hidden
        if (this._status !== 'online' && navigator.onLine) {
          try {
            await this._handleOnline();
          } catch (err) {
            console.warn('[ConnectivityManager] reconnect on visibility error:', err);
          }
        }

        // Mark active conversation as read
        const activeConv = AppState.get('activeConversationId');
        const userId = AppState.get('user')?.id;

        if (activeConv && userId) {
          try {
            await SupabaseService.markMessagesRead(activeConv, userId);

            const counts = AppState.get('unreadCounts');
            if (counts[activeConv] > 0) {
              counts[activeConv] = 0;
              AppState.set('unreadCounts', { ...counts });
              const total = Object.values(counts).reduce((a, b) => a + b, 0);
              AppState.set('totalUnread', total);
            }
          } catch (err) {
            console.warn('[ConnectivityManager] markRead on visibility error:', err);
          }
        }

        // Set status back to online
        if (userId) {
          try {
            await SupabaseService.setUserStatus(userId, 'online');
          } catch (err) {
            console.warn('[ConnectivityManager] setOnline on visibility error:', err);
          }
        }
      } else if (!this._tabVisible && wasVisible) {
        // ── Tab became hidden ──
        eventBus.emit('tab:hidden');

        const userId = AppState.get('user')?.id;
        if (userId) {
          try {
            await SupabaseService.setUserStatus(userId, 'away');
          } catch (err) {
            console.warn('[ConnectivityManager] setAway on visibility error:', err);
          }
        }
      }
    } catch (err) {
      console.error('[ConnectivityManager] _handleVisibilityChange error:', err);
    }
  }

  /** @private */
  _handleBeforeUnload() {
    try {
      const userId = AppState.get('user')?.id;
      if (userId) {
        // Use sendBeacon for reliability during page unload
        const url =
          `${CONFIG.SUPABASE_URL}/rest/v1/user_status?user_id=eq.${userId}`;
        const session = AppState.get('session');
        const headers = {
          'Content-Type': 'application/json',
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${session?.access_token || CONFIG.SUPABASE_ANON_KEY}`,
          'Prefer': 'resolution=merge-duplicates',
        };
        const body = JSON.stringify({
          user_id: userId,
          status: 'offline',
          last_seen: new Date().toISOString(),
        });

        // sendBeacon doesn't support custom headers,
        // so fall back to keepalive fetch where possible
        try {
          fetch(url, {
            method: 'PATCH',
            headers,
            body,
            keepalive: true,
          }).catch(() => { /* page is unloading, ignore */ });
        } catch (_) {
          // Absolute fallback — beacon with plain JSON
          navigator.sendBeacon?.(
            url,
            new Blob([body], { type: 'application/json' })
          );
        }
      }

      // Wipe sensitive material from memory
      CryptoEngine.clearKeys();
    } catch (_) {
      // Page is unloading — nothing we can do
    }
  }

  // ═══════════════════════ PRIVATE — RECONNECTION ═══════════

  /** @private */
  async _reconnect() {
    // Verify Supabase session is still alive
    let session;
    try {
      session = await SupabaseService.getSession();
    } catch (err) {
      console.warn('[ConnectivityManager] _reconnect getSession error:', err);
      throw err;
    }

    if (!session) {
      console.warn('[ConnectivityManager] _reconnect: no active session');
      eventBus.emit('session:expired');
      throw new Error('No active session');
    }

    // Re-subscribe realtime channels
    const userId = AppState.get('user')?.id;
    if (userId) {
      eventBus.emit('realtime:reconnect', { userId });
    }

    AppState.set('connectionStatus', 'connected');
    this._reconnectAttempts = 0;
    this._stopReconnecting();
  }

  /** @private */
  _startReconnecting() {
    if (this._reconnectInterval) return;

    this._setStatus('reconnecting');
    AppState.set('connectionStatus', 'reconnecting');

    const MAX_ATTEMPTS = 15;

    const attemptReconnect = async () => {
      if (!navigator.onLine) {
        // Still offline — retry after base interval
        this._reconnectInterval = setTimeout(attemptReconnect, CONFIG.RECONNECT_INTERVAL_MS);
        return;
      }

      this._reconnectAttempts++;

      console.log(
        `[ConnectivityManager] Reconnect attempt #${this._reconnectAttempts}`
      );

      try {
        await this._reconnect();
        this._setStatus('online');
        this._reconnectInterval = null;
        NotificationService.showToast('Reconnected!', 'success');
      } catch (err) {
        console.warn(
          `[ConnectivityManager] Reconnect attempt #${this._reconnectAttempts} failed:`,
          err.message || err
        );

        if (this._reconnectAttempts >= MAX_ATTEMPTS) {
          this._stopReconnecting();
          this._setStatus('offline');
          NotificationService.showToast(
            'Unable to reconnect. Please check your connection and refresh the page.',
            'error',
            0  // persistent toast
          );
        } else {
          // Exponential back-off with jitter — actually delays the next attempt
          const base = CONFIG.RECONNECT_INTERVAL_MS * Math.pow(1.5, this._reconnectAttempts - 1);
          const jitter = Math.random() * 1000;
          const delay = Math.min(base + jitter, this._maxReconnectDelay);
          console.log(`[ConnectivityManager] Next retry in ${Math.round(delay)}ms`);
          this._reconnectInterval = setTimeout(attemptReconnect, delay);
        }
      }
    };

    // Start first attempt after base interval
    this._reconnectInterval = setTimeout(attemptReconnect, CONFIG.RECONNECT_INTERVAL_MS);
  }

  /** @private */
  _stopReconnecting() {
    if (this._reconnectInterval) {
      clearTimeout(this._reconnectInterval);
      this._reconnectInterval = null;
    }
  }

  // ═══════════════════════ PRIVATE — HEARTBEAT ══════════════

  /**
   * Periodic health check:
   * - Validates session is alive
   * - Updates user's last_seen
   * - Detects stale connections
   * @private
   */
  _startHeartbeat() {
    if (this._heartbeatInterval) return;

    const HEARTBEAT_MS = 30_000;

    this._heartbeatInterval = setInterval(async () => {
      // Skip heartbeat when tab is hidden or we're known-offline
      if (!this._tabVisible) return;
      if (this._status === 'offline') return;

      try {
        const session = await SupabaseService.getSession();

        if (!session) {
          console.warn('[ConnectivityManager] Heartbeat: session gone');
          eventBus.emit('session:expired');
          this._stopHeartbeat();
          return;
        }

        // Update presence timestamp
        const userId = AppState.get('user')?.id;
        if (userId) {
          try {
            await SupabaseService.setUserStatus(userId, 'online');
          } catch (err) {
            console.warn('[ConnectivityManager] Heartbeat: setUserStatus error:', err);
          }
        }

        // If we thought we were disconnected but heartbeat succeeded → recover
        if (this._status !== 'online') {
          this._setStatus('online');
          AppState.set('connectionStatus', 'connected');
          console.log('[ConnectivityManager] Heartbeat recovered connection');
        }
      } catch (err) {
        console.warn('[ConnectivityManager] Heartbeat failed:', err);
        if (navigator.onLine && this._status === 'online') {
          // Internet works but Supabase unreachable
          this._setStatus('reconnecting');
          AppState.set('connectionStatus', 'reconnecting');
          this._startReconnecting();
        }
      }
    }, HEARTBEAT_MS);
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  // ═══════════════════════ PRIVATE — SESSION TIMEOUT ════════

  /** @private */
  _resetSessionTimeout() {
    this._clearSessionTimeout();

    this._sessionTimeout = setTimeout(() => {
      console.warn('[ConnectivityManager] Session timed out due to inactivity');
      eventBus.emit('session:timeout');
      NotificationService.showToast(
        'Session expired due to inactivity. Please log in again.',
        'warning',
        0  // persistent
      );
    }, CONFIG.SESSION_TIMEOUT_MS);
  }

  /** @private */
  _clearSessionTimeout() {
    if (this._sessionTimeout) {
      clearTimeout(this._sessionTimeout);
      this._sessionTimeout = null;
    }
  }

  // ═══════════════════════ PRIVATE — STATUS SETTER ══════════

  /** @private */
  _setStatus(status) {
    const old = this._status;
    if (old === status) return;

    this._status = status;

    const stateMap = {
      online:       'connected',
      offline:      'disconnected',
      reconnecting: 'reconnecting',
    };
    AppState.set('connectionStatus', stateMap[status] || status);

    eventBus.emit('connectivity:change', { status, previous: old });
    console.log(`[ConnectivityManager] Status: ${old} → ${status}`);
  }
}

export const ConnectivityManager = new _ConnectivityManager();

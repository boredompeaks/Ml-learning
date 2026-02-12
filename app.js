/**
 * ═══════════════════════════════════════════════════════════════════════
 *  SecureChat — app.js
 *  Main Entry Point: ThemeManager · Router · EmojiModule · FileModule
 *                    UIRenderer · App Bootstrap
 *  ES6 Module — imports from core.js + services.js
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

import {
  RealtimeManager,
  NotificationService,
  ConnectivityManager,
} from './services.js';


// ─────────────────────────────────────────────────────────────
//  DOM HELPER — safe element builder (never uses innerHTML for user data)
// ─────────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    }
    else node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children).flat()) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }
  return node;
}

/** Shorthand: query inside a scope. */
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];


// ─────────────────────────────────────────────────────────────
//  THEME MANAGER
// ─────────────────────────────────────────────────────────────
const ThemeManager = {
  _current: 'dark',

  init() {
    this._current = AppState.get('theme') || 'dark';
    this.apply(this._current);
  },

  toggle() {
    this._current = this._current === 'dark' ? 'light' : 'dark';
    this.apply(this._current);
    AppState.set('theme', this._current);
    try { localStorage.setItem('securechat_theme', this._current); } catch (_) { /* ok */ }
  },

  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    this._current = theme;
    // Update toggle button icon if present
    const btn = $('#theme-toggle-icon');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  },

  get() { return this._current; },
};


// ─────────────────────────────────────────────────────────────
//  ROUTER — Hash-based SPA routing
// ─────────────────────────────────────────────────────────────
const Router = {
  _currentRoute: '',
  _routes: new Map(),

  init() {
    window.addEventListener('hashchange', () => this._handleRoute());
    // Don't auto-navigate on init — App.init decides first route
  },

  register(route, handler) {
    this._routes.set(route, handler);
  },

  navigate(route) {
    if (window.location.hash === `#${route}`) {
      // Force re-trigger even if same hash
      this._handleRoute();
    } else {
      window.location.hash = route;
    }
  },

  _handleRoute() {
    const hash = window.location.hash.slice(1) || 'auth';
    if (hash === this._currentRoute) return;
    this._currentRoute = hash;

    const handler = this._routes.get(hash);
    if (handler) {
      try { handler(); } catch (e) { console.error('[Router] Handler error for', hash, e); }
    } else {
      // Fallback: try to find a partial match (e.g. "chat/convId")
      const base = hash.split('/')[0];
      const baseHandler = this._routes.get(base);
      if (baseHandler) {
        try { baseHandler(hash); } catch (e) { console.error('[Router] Handler error:', e); }
      }
    }

    eventBus.emit('route:change', { route: hash });
  },

  getCurrentRoute() { return this._currentRoute; },
};


// ─────────────────────────────────────────────────────────────
//  EMOJI MODULE — Built-in emoji data + picker logic
// ─────────────────────────────────────────────────────────────
const EmojiModule = {
  _data: {
    'Smileys':  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','😡','😠','🤬','😷','🤒','🤕','🤢','🤮','🥴','😇','🥳','🥺','🤠','🤡','🤥','🤫','🤭'],
    'Gestures': ['👋','🤚','🖐','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💪'],
    'Hearts':   ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️'],
    'Animals':  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞'],
    'Food':     ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🥦','🌶','🌽','🥕','🍔','🍟','🍕','🌭','🍿','🧂','🍺','🍷','☕','🍵','🍰','🎂','🍩','🍪'],
    'Objects':  ['💬','💭','🔥','⭐','🌟','✨','💫','🎉','🎊','🎈','💯','🔔','🎵','🎶','🔑','🔒','🔓','💡','📱','💻','📷','📞','📧','📝','📌','📎','✂️','🗑'],
    'Symbols':  ['✅','❌','⭕','🚫','💤','💢','♻️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','▶️','⏸','⏹','⏺','🔀','🔁','🔂','➕','➖','➗','✖️','💲','💱'],
  },

  _recent: [],

  getCategories() { return Object.keys(this._data); },
  getEmojis(category) { return this._data[category] || []; },

  addRecent(emoji) {
    this._recent = [emoji, ...this._recent.filter(e => e !== emoji)].slice(0, 24);
    try { localStorage.setItem('securechat_recent_emoji', JSON.stringify(this._recent)); } catch (_) {}
  },

  loadRecent() {
    try {
      const r = localStorage.getItem('securechat_recent_emoji');
      if (r) this._recent = JSON.parse(r);
    } catch (_) {}
  },

  getRecent() { return this._recent; },
};


// ─────────────────────────────────────────────────────────────
//  FILE MODULE — Encrypted file upload/download
// ─────────────────────────────────────────────────────────────
const FileModule = {

  /**
   * Encrypt and upload a file.
   * @returns {Promise<{url:string, metadata:Object}>}
   */
  async uploadFile(file, conversationId) {
    const user = AppState.get('user');
    const passkey = CryptoEngine.getPasskey(conversationId);
    const salt = AppState.get('passkeySalts')[conversationId];

    if (!passkey || !salt) throw new Error('No passkey set for this conversation');
    if (file.size > CONFIG.MAX_FILE_SIZE) throw new Error('File too large (max 10 MB)');

    const fileData = await file.arrayBuffer();
    const { ciphertext, iv } = await CryptoEngine.encryptFile(fileData, passkey, salt);

    const url = await SupabaseService.uploadEncryptedFile(
      conversationId, file.name, ciphertext
    );

    const metadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      iv,
      isImage: CONFIG.SUPPORTED_IMAGE_TYPES.includes(file.type),
    };

    return { url, metadata };
  },

  /**
   * Download and decrypt a file.
   * @returns {Promise<{blob:Blob, name:string}|null>}
   */
  async downloadFile(url, metadata, conversationId) {
    const passkey = CryptoEngine.getPasskey(conversationId);
    const salt = AppState.get('passkeySalts')[conversationId];

    if (!passkey || !salt) {
      NotificationService.showToast('Enter passkey first', 'warning');
      return null;
    }

    try {
      const encrypted = await SupabaseService.downloadEncryptedFile(url);
      const decrypted = await CryptoEngine.decryptFile(encrypted, metadata.iv, passkey, salt);

      if (!decrypted) {
        NotificationService.showToast('Failed to decrypt file — wrong passkey?', 'error');
        return null;
      }

      const blob = new Blob([decrypted], { type: metadata.type || 'application/octet-stream' });
      return { blob, name: metadata.name };
    } catch (err) {
      console.error('[FileModule] downloadFile error:', err);
      NotificationService.showToast('File download failed', 'error');
      return null;
    }
  },

  /** Trigger browser download of a Blob. */
  saveBlobAs(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  },
};


// ─────────────────────────────────────────────────────────────
//  UI RENDERER — All DOM rendering and interaction logic
// ─────────────────────────────────────────────────────────────
const UIRenderer = {
  /** Cached DOM refs — populated on init. */
  _refs: {},

  /** Current reply-to target. */
  _replyTo: null,

  /** Scroll state. */
  _isNearBottom: true,
  _loadingOlder: false,

  /** Context menu target. */
  _contextMessage: null,

  /** EventBus unsub handles. */
  _unsubs: [],

  // ═══════════════════════ INIT ═════════════════════════════

  init() {
    this._cacheRefs();
    this._bindDOMEvents();
    this._bindStateWatchers();
    this._bindEventBusListeners();
    EmojiModule.loadRecent();
  },

  _cacheRefs() {
    this._refs = {
      authView:       $('#auth-view'),
      appView:        $('#app-view'),
      loginForm:      $('#login-form'),
      registerForm:   $('#register-form'),
      loginEmail:     $('#login-email'),
      loginPassword:  $('#login-password'),
      loginBtn:       $('#login-btn'),
      loginError:     $('#login-error'),
      regEmail:       $('#reg-email'),
      regPassword:    $('#reg-password'),
      regConfirm:     $('#reg-confirm'),
      regName:        $('#reg-name'),
      regBtn:         $('#reg-btn'),
      regError:       $('#reg-error'),
      pwChecks:       $('#pw-checks'),
      pwStrength:     $('#pw-strength-bar'),
      sidebar:        $('#sidebar'),
      sidebarOverlay: $('#sidebar-overlay'),
      userAvatar:     $('#user-avatar'),
      userName:       $('#user-name'),
      convList:       $('#conversation-list'),
      contactsView:   $('#contacts-view'),
      settingsView:   $('#settings-view'),
      chatEmpty:      $('#chat-empty'),
      chatActive:     $('#chat-active'),
      chatPartnerAv:  $('#chat-partner-avatar'),
      chatPartnerNm:  $('#chat-partner-name'),
      chatPartnerSt:  $('#chat-partner-status'),
      messagesArea:   $('#messages-area'),
      typingIndicator:$('#typing-indicator'),
      messageInput:   $('#message-input'),
      sendBtn:        $('#send-btn'),
      replyPreview:   $('#reply-preview'),
      scrollBottom:   $('#scroll-bottom-btn'),
      emojiPicker:    $('#emoji-picker'),
      contextMenu:    $('#context-menu'),
      connectionBar:  $('#connection-bar'),
      passkeyModal:   $('#passkey-modal'),
      passkeyInput:   $('#passkey-input'),
      passkeyStrength:$('#passkey-strength'),
      passkeyError:   $('#passkey-error'),
      searchModal:    $('#search-modal'),
      searchInput:    $('#search-input'),
      searchResults:  $('#search-results'),
      profileModal:   $('#profile-modal'),
      fileInput:      $('#file-input'),
      imagePreview:   $('#image-preview-modal'),
      loadingOverlay: $('#loading-overlay'),
    };
  },

  // ═══════════════════════ VIEW SWITCHING ════════════════════

  showAuth() {
    if (this._refs.authView) this._refs.authView.hidden = false;
    if (this._refs.appView)  this._refs.appView.hidden = true;
    this._clearAuthForms();
  },

  showApp() {
    if (this._refs.authView) this._refs.authView.hidden = true;
    if (this._refs.appView)  this._refs.appView.hidden = false;
    this._updateUserProfile();
  },

  showLoading(show = true) {
    if (this._refs.loadingOverlay) this._refs.loadingOverlay.hidden = !show;
  },

  /** Switch sidebar sub-view: chats | contacts | settings */
  showSidebarView(view) {
    AppState.set('activeView', view);
    const views = { chats: this._refs.convList, contacts: this._refs.contactsView, settings: this._refs.settingsView };
    for (const [k, el] of Object.entries(views)) {
      if (el) el.hidden = k !== view;
    }
    // Update nav active state
    $$('.sidebar-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));

    if (view === 'contacts') this._loadContacts();
    if (view === 'settings') this._renderSettings();
  },

  // ═══════════════════════ AUTH ══════════════════════════════

  _clearAuthForms() {
    if (this._refs.loginEmail)    this._refs.loginEmail.value = '';
    if (this._refs.loginPassword) this._refs.loginPassword.value = '';
    if (this._refs.regEmail)      this._refs.regEmail.value = '';
    if (this._refs.regPassword)   this._refs.regPassword.value = '';
    if (this._refs.regConfirm)    this._refs.regConfirm.value = '';
    if (this._refs.regName)       this._refs.regName.value = '';
    if (this._refs.loginError)    this._refs.loginError.textContent = '';
    if (this._refs.regError)      this._refs.regError.textContent = '';
  },

  showLoginForm() {
    if (this._refs.loginForm)    this._refs.loginForm.hidden = false;
    if (this._refs.registerForm) this._refs.registerForm.hidden = true;
  },

  showRegisterForm() {
    if (this._refs.loginForm)    this._refs.loginForm.hidden = true;
    if (this._refs.registerForm) this._refs.registerForm.hidden = false;
  },

  async handleLogin(e) {
    e?.preventDefault();
    const email = this._refs.loginEmail?.value?.trim();
    const password = this._refs.loginPassword?.value;

    if (!email || !password) {
      this._showFieldError('loginError', 'Please fill in all fields');
      return;
    }
    if (!Utils.validateEmail(email)) {
      this._showFieldError('loginError', 'Invalid email address');
      return;
    }

    this._setButtonLoading('loginBtn', true);

    try {
      const { session, user } = await SupabaseService.signIn(email, password);
      AppState.batch({ user, session });
      await App.loadUserData(user);
      this.showApp();
      Router.navigate('chat');
    } catch (err) {
      console.error('[UIRenderer] Login error:', err);
      this._showFieldError('loginError', err.message || 'Login failed');
    } finally {
      this._setButtonLoading('loginBtn', false);
    }
  },

  async handleRegister(e) {
    e?.preventDefault();
    const email    = this._refs.regEmail?.value?.trim();
    const password = this._refs.regPassword?.value;
    const confirm  = this._refs.regConfirm?.value;
    const name     = this._refs.regName?.value?.trim();

    if (!email || !password || !confirm || !name) {
      this._showFieldError('regError', 'Please fill in all fields');
      return;
    }
    if (!Utils.validateEmail(email)) {
      this._showFieldError('regError', 'Invalid email address');
      return;
    }
    if (password !== confirm) {
      this._showFieldError('regError', 'Passwords do not match');
      return;
    }
    const pwCheck = Utils.validatePassword(password);
    if (!pwCheck.valid) {
      this._showFieldError('regError', 'Password does not meet requirements');
      return;
    }

    this._setButtonLoading('regBtn', true);

    try {
      await SupabaseService.signUp(email, password, name);
      NotificationService.showToast('Account created! Check your email to confirm.', 'success');
      this.showLoginForm();
    } catch (err) {
      console.error('[UIRenderer] Register error:', err);
      this._showFieldError('regError', err.message || 'Registration failed');
    } finally {
      this._setButtonLoading('regBtn', false);
    }
  },

  // ═══════════════════════ USER PROFILE ═════════════════════

  _updateUserProfile() {
    const profile = AppState.get('profile');
    const user = AppState.get('user');
    if (!profile && !user) return;

    const name = profile?.display_name || user?.user_metadata?.display_name || 'User';
    if (this._refs.userName) this._refs.userName.textContent = name;

    if (this._refs.userAvatar) {
      if (profile?.avatar_url) {
        this._refs.userAvatar.style.backgroundImage = `url(${profile.avatar_url})`;
        this._refs.userAvatar.textContent = '';
      } else {
        this._refs.userAvatar.style.backgroundImage = '';
        this._refs.userAvatar.textContent = Utils.getInitials(name);
        this._refs.userAvatar.style.backgroundColor = Utils.stringToColor(name);
      }
    }
  },

  // ═══════════════════════ CONVERSATION LIST ════════════════

  async renderConversations() {
    const convs = AppState.get('conversations') || [];
    const container = this._refs.convList;
    if (!container) return;

    // Keep the nav portion, clear conversation items
    const items = container.querySelector('.conv-items');
    if (!items) return;

    if (convs.length === 0) {
      items.innerHTML = '';
      items.appendChild(
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-icon', text: '💬' }),
          el('p', { text: 'No conversations yet' }),
          el('p', { class: 'empty-sub', text: 'Start chatting with a contact' }),
        ])
      );
      return;
    }

    const user = AppState.get('user');
    const unread = AppState.get('unreadCounts') || {};
    const online = AppState.get('onlineUsers');
    const activeId = AppState.get('activeConversationId');

    const frag = document.createDocumentFragment();

    for (const conv of convs) {
      const partner = this._getPartner(conv);
      const partnerName = partner?.profile?.display_name || 'Unknown';
      const isOnline = online.has(partner?.user_id);
      const count = unread[conv.id] || 0;
      const isActive = conv.id === activeId;

      const item = el('div', {
        class: `conv-item${isActive ? ' active' : ''}`,
        dataset: { convId: conv.id },
        role: 'button',
        tabindex: '0',
        'aria-label': `Chat with ${partnerName}`,
      }, [
        this._buildAvatar(partner?.profile, 'conv-avatar', isOnline),
        el('div', { class: 'conv-info' }, [
          el('div', { class: 'conv-top' }, [
            el('span', { class: 'conv-name', text: partnerName }),
            el('span', { class: 'conv-time', text: Utils.timeAgo(conv.updated_at) }),
          ]),
          el('div', { class: 'conv-bottom' }, [
            el('span', { class: 'conv-preview', text: '🔒 Encrypted message' }),
            count > 0
              ? el('span', { class: 'unread-badge', text: String(count > 99 ? '99+' : count) })
              : null,
          ]),
        ]),
      ]);

      frag.appendChild(item);
    }

    items.innerHTML = '';
    items.appendChild(frag);
  },

  // ═══════════════════════ OPEN CONVERSATION ════════════════

  async openConversation(conversationId) {
    if (!conversationId) return;

    const convs = AppState.get('conversations') || [];
    const conv = convs.find(c => c.id === conversationId);
    if (!conv) {
      NotificationService.showToast('Conversation not found', 'error');
      return;
    }

    // Check if passkey is already set
    const passkey = CryptoEngine.getPasskey(conversationId);
    if (!passkey) {
      this._showPasskeyModal(conversationId);
      return;
    }

    // Ensure we have the salt
    await this._ensureSalt(conversationId, conv);

    // Show chat view
    if (this._refs.chatEmpty) this._refs.chatEmpty.hidden = true;
    if (this._refs.chatActive) this._refs.chatActive.hidden = false;

    // Update header
    const partner = this._getPartner(conv);
    this._updateChatHeader(partner);

    // Enter conversation (realtime)
    try {
      await RealtimeManager.enterConversation(conversationId);
    } catch (err) {
      console.error('[UIRenderer] enterConversation error:', err);
    }

    // Load and render messages
    await this._loadMessages(conversationId);

    // Re-render conversation list to update active state
    this.renderConversations();

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
      this._closeSidebar();
    }
  },

  async _loadMessages(conversationId, before = null) {
    const pagination = AppState.get('messagePagination')[conversationId] || { hasMore: true, loading: false };
    if (pagination.loading) return;
    if (!before && !pagination.hasMore && (AppState.get('messages')[conversationId] || []).length > 0) return;

    AppState.merge('messagePagination', conversationId, { ...pagination, loading: true });

    try {
      const msgs = await SupabaseService.getMessages(conversationId, {
        limit: CONFIG.MESSAGE_PAGE_SIZE,
        before,
      });

      const existing = before ? (AppState.get('messages')[conversationId] || []) : [];
      const merged = before ? [...msgs, ...existing] : msgs;

      // Deduplicate
      const seen = new Set();
      const unique = merged.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      AppState.merge('messages', conversationId, unique);
      AppState.merge('messagePagination', conversationId, {
        hasMore: msgs.length >= CONFIG.MESSAGE_PAGE_SIZE,
        loading: false,
      });

      await this.renderMessages(conversationId, !before);
    } catch (err) {
      console.error('[UIRenderer] _loadMessages error:', err);
      AppState.merge('messagePagination', conversationId, { ...pagination, loading: false });
      NotificationService.showToast('Failed to load messages', 'error');
    }
  },

  // ═══════════════════════ MESSAGE RENDERING ════════════════

  async renderMessages(conversationId, scrollToEnd = true) {
    const container = this._refs.messagesArea;
    if (!container) return;

    const messages = AppState.get('messages')[conversationId] || [];
    const passkey = CryptoEngine.getPasskey(conversationId);
    const salt = AppState.get('passkeySalts')[conversationId];
    const user = AppState.get('user');
    const convs = AppState.get('conversations') || [];
    const conv = convs.find(c => c.id === conversationId);

    if (messages.length === 0) {
      container.innerHTML = '';
      container.appendChild(
        el('div', { class: 'empty-state chat-empty-messages' }, [
          el('div', { class: 'empty-icon', text: '🔐' }),
          el('p', { text: 'No messages yet' }),
          el('p', { class: 'empty-sub', text: 'Send the first encrypted message' }),
        ])
      );
      return;
    }

    // Decrypt all messages
    const decrypted = await Promise.all(messages.map(async msg => {
      // Deleted
      if (msg.status === 'deleted' || (!msg.ciphertext && msg.deleted_at)) {
        return { ...msg, _text: '🗑️ This message was deleted', _ok: false, _deleted: true };
      }
      // Hidden for user
      if (msg.hidden_for && msg.hidden_for.includes(user?.id)) {
        return null; // skip
      }
      // No passkey
      if (!passkey || !salt) {
        return { ...msg, _text: '🔒 Enter passkey to decrypt', _ok: false };
      }
      // Decrypt
      try {
        const result = await CryptoEngine.decrypt(msg.ciphertext, msg.iv, passkey, salt);
        return { ...msg, _text: result.text, _ok: result.success };
      } catch (err) {
        return { ...msg, _text: '🔒 Decryption error', _ok: false };
      }
    }));

    const visible = decrypted.filter(Boolean);

    // Build DOM
    const frag = document.createDocumentFragment();
    let lastDate = '';

    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const msgDate = Utils.formatDate(msg.created_at);

      // Date separator
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        frag.appendChild(el('div', { class: 'date-separator', role: 'separator' }, [
          el('span', { text: msgDate }),
        ]));
      }

      const isOwn = msg.sender_id === user?.id;
      const bubble = this._buildMessageBubble(msg, isOwn, conv, visible);
      frag.appendChild(bubble);
    }

    // Preserve scroll position if loading older messages
    const prevHeight = container.scrollHeight;
    const prevScroll = container.scrollTop;

    container.innerHTML = '';
    container.appendChild(frag);

    if (scrollToEnd) {
      this._scrollToBottom(true);
    } else {
      // Restore scroll position after prepending older messages
      const newHeight = container.scrollHeight;
      container.scrollTop = prevScroll + (newHeight - prevHeight);
    }
  },

  _buildMessageBubble(msg, isOwn, conv, allMessages) {
    const partner = isOwn ? null : this._getPartner(conv);
    const senderName = isOwn
      ? 'You'
      : (partner?.profile?.display_name || 'Unknown');

    // Reply quote
    let replyQuote = null;
    if (msg.reply_to_id) {
      const original = allMessages.find(m => m.id === msg.reply_to_id);
      if (original) {
        replyQuote = el('div', { class: 'reply-quote' }, [
          el('span', { class: 'reply-quote-name', text: original.sender_id === AppState.get('user')?.id ? 'You' : senderName }),
          el('span', { class: 'reply-quote-text', text: original._ok ? (original._text || '').slice(0, 80) : '🔒 Encrypted' }),
        ]);
      }
    }

    // Message content
    let contentEl;
    if (msg._deleted) {
      contentEl = el('span', { class: 'msg-deleted', text: msg._text });
    } else if (msg.message_type === 'file' && msg.file_metadata) {
      contentEl = this._buildFileContent(msg);
    } else {
      contentEl = this._buildTextContent(msg._text, msg._ok);
    }

    // Status indicator for own messages
    let statusEl = null;
    if (isOwn && !msg._deleted) {
      const statusMap = {
        sending: '⏳', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠️',
      };
      const statusText = statusMap[msg.status] || '✓';
      statusEl = el('span', {
        class: `msg-status${msg.status === 'read' ? ' read' : ''}`,
        text: statusText,
        title: msg.status || 'sent',
      });
    }

    // Gibberish indicator
    let gibberishHint = null;
    if (!msg._ok && !msg._deleted && msg.ciphertext) {
      gibberishHint = el('span', { class: 'gibberish-hint', text: '⚠️ Wrong passkey?', title: 'Message cannot be decrypted with current passkey' });
    }

    const bubble = el('div', {
      class: `message ${isOwn ? 'own' : 'other'}${msg._deleted ? ' deleted' : ''}`,
      dataset: { msgId: msg.id, senderId: msg.sender_id },
    }, [
      !isOwn ? this._buildAvatar(partner?.profile, 'msg-avatar') : null,
      el('div', { class: 'msg-bubble' }, [
        !isOwn ? el('span', { class: 'msg-sender', text: senderName }) : null,
        replyQuote,
        contentEl,
        gibberishHint,
        el('div', { class: 'msg-meta' }, [
          el('span', {
            class: 'msg-time',
            text: Utils.formatTime(msg.created_at),
            title: new Date(msg.created_at).toLocaleString(),
          }),
          statusEl,
        ]),
      ]),
    ]);

    // Context menu on right-click (and long-press)
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showContextMenu(e, msg, isOwn);
    });

    return bubble;
  },

  _buildTextContent(text, decryptOk) {
    if (!text) return el('span', { class: 'msg-text', text: '' });

    // Detect links in successfully decrypted text
    if (decryptOk) {
      const links = Utils.extractLinks(text);
      if (links.length > 0) {
        const container = el('span', { class: 'msg-text' });
        let remaining = text;
        for (const link of links) {
          const idx = remaining.indexOf(link);
          if (idx > 0) {
            container.appendChild(document.createTextNode(remaining.slice(0, idx)));
          }
          const a = el('a', {
            href: link,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'msg-link',
            text: link,
          });
          container.appendChild(a);
          remaining = remaining.slice(idx + link.length);
        }
        if (remaining) container.appendChild(document.createTextNode(remaining));
        return container;
      }
    }

    return el('span', {
      class: `msg-text${!decryptOk ? ' gibberish' : ''}`,
      text,
    });
  },

  _buildFileContent(msg) {
    const meta = msg.file_metadata;
    if (!meta) return el('span', { class: 'msg-text', text: '📎 File' });

    const sizeStr = meta.size < 1024 ? `${meta.size} B`
      : meta.size < 1048576 ? `${(meta.size / 1024).toFixed(1)} KB`
      : `${(meta.size / 1048576).toFixed(1)} MB`;

    return el('div', { class: 'file-attachment' }, [
      el('div', { class: 'file-icon', text: meta.isImage ? '🖼️' : '📄' }),
      el('div', { class: 'file-info' }, [
        el('span', { class: 'file-name', text: meta.name || 'File' }),
        el('span', { class: 'file-size', text: sizeStr }),
      ]),
      el('button', {
        class: 'file-download-btn',
        text: '⬇️',
        title: 'Download & decrypt',
        onClick: async () => {
          const convId = AppState.get('activeConversationId');
          try {
            const result = await FileModule.downloadFile(msg.file_metadata?.url || msg.ciphertext, meta, convId);
            if (result) {
              if (meta.isImage) {
                this._showImagePreview(result.blob, result.name);
              } else {
                FileModule.saveBlobAs(result.blob, result.name);
              }
            }
          } catch (err) {
            NotificationService.showToast('Download failed', 'error');
          }
        },
      }),
    ]);
  },

  // ═══════════════════════ SEND MESSAGE ═════════════════════

  async handleSendMessage() {
    const input = this._refs.messageInput;
    if (!input) return;

    const raw = input.value;
    const text = Utils.sanitizeInput(raw);
    if (!text) return;

    const convId = AppState.get('activeConversationId');
    const user = AppState.get('user');
    const passkey = CryptoEngine.getPasskey(convId);
    const salt = AppState.get('passkeySalts')[convId];

    if (!convId || !user || !passkey || !salt) {
      NotificationService.showToast('Cannot send — missing passkey or conversation', 'warning');
      return;
    }

    // Clear input immediately (responsive feel)
    input.value = '';
    this._autoGrowTextarea(input);

    // Stop typing indicator
    try { await RealtimeManager.stopTyping(convId); } catch (_) {}

    const idempotencyKey = CryptoEngine.generateId();

    // Optimistic insert
    const optimistic = {
      id: `temp-${idempotencyKey}`,
      conversation_id: convId,
      sender_id: user.id,
      ciphertext: null,
      iv: null,
      status: 'sending',
      created_at: new Date().toISOString(),
      reply_to_id: this._replyTo?.id || null,
      message_type: 'text',
      _text: text,
      _ok: true,
      _optimistic: true,
    };

    const msgs = AppState.get('messages')[convId] || [];
    msgs.push(optimistic);
    AppState.merge('messages', convId, [...msgs]);
    await this.renderMessages(convId, true);

    // Capture reply-to before clearing (avoid race condition)
    const replyToId = this._replyTo?.id || null;

    // Clear reply
    this._clearReply();

    // Encrypt and send
    try {
      const { ciphertext, iv } = await CryptoEngine.encrypt(text, passkey, salt);

      if (!ConnectivityManager.isOnline()) {
        ConnectivityManager.queueMessage({
          conversationId: convId,
          userId: user.id,
          ciphertext, iv,
          idempotencyKey,
          replyToId,
        });
        // Update optimistic message status
        this._updateOptimisticStatus(convId, idempotencyKey, 'queued');
        NotificationService.showToast('Message queued for sending', 'info');
        return;
      }

      const sent = await SupabaseService.sendMessage(convId, user.id, {
        ciphertext, iv, idempotencyKey,
        replyToId: optimistic.reply_to_id,
      });

      // Replace optimistic with real message
      this._replaceOptimistic(convId, idempotencyKey, sent);

    } catch (err) {
      console.error('[UIRenderer] sendMessage error:', err);
      this._updateOptimisticStatus(convId, idempotencyKey, 'failed');
      NotificationService.showToast('Failed to send message', 'error');
    }
  },

  _updateOptimisticStatus(convId, idempKey, status) {
    const msgs = AppState.get('messages')[convId] || [];
    const idx = msgs.findIndex(m => m._optimistic && m.id === `temp-${idempKey}`);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], status };
      AppState.merge('messages', convId, [...msgs]);
      this.renderMessages(convId, false);
    }
  },

  _replaceOptimistic(convId, idempKey, realMsg) {
    const msgs = AppState.get('messages')[convId] || [];
    const idx = msgs.findIndex(m => m._optimistic && m.id === `temp-${idempKey}`);
    if (idx !== -1) {
      msgs[idx] = realMsg;
    } else {
      // Avoid duplicate
      if (!msgs.some(m => m.id === realMsg.id)) {
        msgs.push(realMsg);
      }
    }
    AppState.merge('messages', convId, [...msgs]);
  },

  // ═══════════════════════ FILE SEND ════════════════════════

  async handleFileSend(file) {
    const convId = AppState.get('activeConversationId');
    const user = AppState.get('user');
    if (!convId || !user) return;

    const passkey = CryptoEngine.getPasskey(convId);
    if (!passkey) {
      NotificationService.showToast('Enter passkey first', 'warning');
      return;
    }

    if (file.size > CONFIG.MAX_FILE_SIZE) {
      NotificationService.showToast('File too large (max 10 MB)', 'error');
      return;
    }

    NotificationService.showToast('Encrypting & uploading file...', 'info');

    try {
      const { url, metadata } = await FileModule.uploadFile(file, convId);
      metadata.url = url;

      const salt = AppState.get('passkeySalts')[convId];
      const { ciphertext, iv } = await CryptoEngine.encrypt(
        `📎 ${file.name}`, passkey, salt
      );

      await SupabaseService.sendMessage(convId, user.id, {
        ciphertext, iv,
        idempotencyKey: CryptoEngine.generateId(),
        messageType: 'file',
        fileMetadata: metadata,
      });

      NotificationService.showToast('File sent!', 'success');
    } catch (err) {
      console.error('[UIRenderer] handleFileSend error:', err);
      NotificationService.showToast('File upload failed', 'error');
    }
  },

  // ═══════════════════════ PASSKEY MODAL ════════════════════

  _showPasskeyModal(conversationId) {
    const modal = this._refs.passkeyModal;
    if (!modal) return;

    modal.hidden = false;
    modal.dataset.convId = conversationId;

    if (this._refs.passkeyInput) {
      this._refs.passkeyInput.value = '';
      this._refs.passkeyInput.focus();
    }
    if (this._refs.passkeyError) this._refs.passkeyError.textContent = '';
    if (this._refs.passkeyStrength) {
      this._refs.passkeyStrength.style.width = '0%';
      this._refs.passkeyStrength.style.backgroundColor = '';
    }

    // Check lockout
    if (CryptoEngine.isLockedOut(conversationId)) {
      if (this._refs.passkeyError) {
        this._refs.passkeyError.textContent = 'Too many attempts. Please wait 60 seconds.';
      }
      if (this._refs.passkeyInput) this._refs.passkeyInput.disabled = true;
      setTimeout(() => {
        if (this._refs.passkeyInput) this._refs.passkeyInput.disabled = false;
        if (this._refs.passkeyError) this._refs.passkeyError.textContent = '';
      }, CONFIG.PASSKEY_LOCKOUT_DURATION_MS);
    }
  },

  async _handlePasskeySubmit() {
    const modal = this._refs.passkeyModal;
    const input = this._refs.passkeyInput;
    if (!modal || !input) return;

    const convId = modal.dataset.convId;
    const passkey = input.value;

    if (!passkey || passkey.length < CONFIG.PASSKEY_MIN_LENGTH) {
      if (this._refs.passkeyError) {
        this._refs.passkeyError.textContent = `Passkey must be at least ${CONFIG.PASSKEY_MIN_LENGTH} characters`;
      }
      return;
    }

    if (CryptoEngine.isLockedOut(convId)) {
      if (this._refs.passkeyError) {
        this._refs.passkeyError.textContent = 'Locked out. Please wait.';
      }
      return;
    }

    // Store passkey
    CryptoEngine.setPasskey(convId, passkey);

    // Ensure salt
    const convs = AppState.get('conversations') || [];
    const conv = convs.find(c => c.id === convId);
    await this._ensureSalt(convId, conv);

    // Validate passkey by trying to decrypt first message (if any)
    const salt = AppState.get('passkeySalts')[convId];
    if (salt) {
      const msgs = AppState.get('messages')[convId] || [];
      if (msgs.length > 0) {
        const firstWithCipher = msgs.find(m => m.ciphertext && m.iv);
        if (firstWithCipher) {
          const result = await CryptoEngine.decrypt(
            firstWithCipher.ciphertext, firstWithCipher.iv, passkey, salt
          );
          if (!result.success) {
            // Don't block — passkey might be intentionally different
            // Just record the attempt
            CryptoEngine.recordFailedAttempt(convId);
          } else {
            CryptoEngine.resetAttempts(convId);
          }
        }
      }
    }

    // Close modal and open conversation
    modal.hidden = true;
    input.value = '';
    this.openConversation(convId);
  },

  // ═══════════════════════ CONTACTS ═════════════════════════

  async _loadContacts() {
    const user = AppState.get('user');
    if (!user) return;

    try {
      const [contacts, requests, blocked] = await Promise.all([
        SupabaseService.getContacts(user.id),
        SupabaseService.getContactRequests(user.id),
        SupabaseService.getBlockedUsers(user.id),
      ]);

      AppState.batch({
        contacts,
        contactRequests: requests,
        blockedUsers: blocked,
      });

      this._renderContacts();
    } catch (err) {
      console.error('[UIRenderer] _loadContacts error:', err);
      NotificationService.showToast('Failed to load contacts', 'error');
    }
  },

  _renderContacts() {
    const container = this._refs.contactsView;
    if (!container) return;

    const contacts = AppState.get('contacts') || [];
    const requests = AppState.get('contactRequests') || [];
    const blocked = AppState.get('blockedUsers') || [];
    const online = AppState.get('onlineUsers');

    container.innerHTML = '';

    // Search bar
    container.appendChild(
      el('div', { class: 'contacts-search' }, [
        el('button', {
          class: 'btn btn-primary btn-sm',
          text: '🔍 Find Users',
          onClick: () => this._showSearchModal(),
        }),
      ])
    );

    // Tabs
    const tabs = el('div', { class: 'contact-tabs' });
    const tabData = [
      { id: 'all', label: `All (${contacts.length})` },
      { id: 'requests', label: `Requests (${requests.length})` },
      { id: 'blocked', label: `Blocked (${blocked.length})` },
    ];

    let activeTab = 'all';

    const renderTabContent = (tab) => {
      activeTab = tab;
      const content = container.querySelector('.contact-tab-content');
      if (!content) return;
      content.innerHTML = '';

      $$('.contact-tab', tabs).forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab)
      );

      if (tab === 'all') {
        if (contacts.length === 0) {
          content.appendChild(el('div', { class: 'empty-state small' }, [
            el('p', { text: 'No contacts yet' }),
          ]));
        } else {
          for (const c of contacts) {
            content.appendChild(this._buildContactItem(c.contact, online.has(c.contact?.id), [
              el('button', { class: 'btn btn-sm', text: '💬', title: 'Start chat', onClick: () => this._startConversation(c.contact.id) }),
              el('button', { class: 'btn btn-sm btn-danger', text: '✕', title: 'Remove', onClick: () => this._removeContact(c.contact.id) }),
            ]));
          }
        }
      } else if (tab === 'requests') {
        if (requests.length === 0) {
          content.appendChild(el('div', { class: 'empty-state small' }, [
            el('p', { text: 'No pending requests' }),
          ]));
        } else {
          for (const r of requests) {
            content.appendChild(this._buildContactItem(r.requester, false, [
              el('button', { class: 'btn btn-sm btn-success', text: '✓ Accept', onClick: () => this._acceptRequest(r) }),
              el('button', { class: 'btn btn-sm btn-danger', text: '✕ Decline', onClick: () => this._declineRequest(r.id) }),
            ]));
          }
        }
      } else if (tab === 'blocked') {
        if (blocked.length === 0) {
          content.appendChild(el('div', { class: 'empty-state small' }, [
            el('p', { text: 'No blocked users' }),
          ]));
        } else {
          for (const b of blocked) {
            content.appendChild(this._buildContactItem(b.blocked, false, [
              el('button', { class: 'btn btn-sm', text: 'Unblock', onClick: () => this._unblockUser(b.blocked_user_id) }),
            ]));
          }
        }
      }
    };

    for (const t of tabData) {
      const btn = el('button', {
        class: `contact-tab${t.id === 'all' ? ' active' : ''}`,
        text: t.label,
        dataset: { tab: t.id },
        onClick: () => renderTabContent(t.id),
      });
      tabs.appendChild(btn);
    }

    container.appendChild(tabs);
    container.appendChild(el('div', { class: 'contact-tab-content' }));
    renderTabContent('all');
  },

  _buildContactItem(user, isOnline, actions = []) {
    return el('div', { class: 'contact-item' }, [
      this._buildAvatar(user, 'contact-avatar', isOnline),
      el('div', { class: 'contact-info' }, [
        el('span', { class: 'contact-name', text: user?.display_name || 'Unknown' }),
        el('span', { class: 'contact-email', text: user?.email || '' }),
        user?.status_message ? el('span', { class: 'contact-status-msg', text: user.status_message }) : null,
      ]),
      el('div', { class: 'contact-actions' }, actions),
    ]);
  },

  async _startConversation(contactId) {
    const user = AppState.get('user');
    if (!user) return;

    try {
      const convId = await SupabaseService.getOrCreateConversation(user.id, contactId);
      if (!convId) throw new Error('Failed to create conversation');

      // Reload conversations
      const convs = await SupabaseService.getConversations(user.id);
      AppState.set('conversations', convs);
      this.renderConversations();

      // Switch to chat view and open
      this.showSidebarView('chats');
      this.openConversation(convId);
    } catch (err) {
      console.error('[UIRenderer] _startConversation error:', err);
      NotificationService.showToast('Failed to start conversation', 'error');
    }
  },

  async _acceptRequest(request) {
    const user = AppState.get('user');
    if (!user) return;
    try {
      await SupabaseService.acceptContactRequest(request.id, user.id, request.user_id);
      NotificationService.showToast('Contact request accepted!', 'success');
      await this._loadContacts();
    } catch (err) {
      console.error('[UIRenderer] _acceptRequest error:', err);
      NotificationService.showToast('Failed to accept request', 'error');
    }
  },

  async _declineRequest(requestId) {
    try {
      await SupabaseService.declineContactRequest(requestId);
      NotificationService.showToast('Request declined', 'info');
      await this._loadContacts();
    } catch (err) {
      console.error('[UIRenderer] _declineRequest error:', err);
      NotificationService.showToast('Failed to decline', 'error');
    }
  },

  async _removeContact(contactId) {
    const user = AppState.get('user');
    if (!user) return;
    if (!confirm('Remove this contact?')) return;
    try {
      await SupabaseService.removeContact(user.id, contactId);
      NotificationService.showToast('Contact removed', 'info');
      await this._loadContacts();
    } catch (err) {
      console.error('[UIRenderer] _removeContact error:', err);
      NotificationService.showToast('Failed to remove contact', 'error');
    }
  },

  async _unblockUser(blockedId) {
    const user = AppState.get('user');
    if (!user) return;
    try {
      await SupabaseService.unblockUser(user.id, blockedId);
      NotificationService.showToast('User unblocked', 'info');
      await this._loadContacts();
    } catch (err) {
      console.error('[UIRenderer] _unblockUser error:', err);
      NotificationService.showToast('Failed to unblock', 'error');
    }
  },

  // ═══════════════════════ SEARCH MODAL ═════════════════════

  _showSearchModal() {
    const modal = this._refs.searchModal;
    if (!modal) return;
    modal.hidden = false;
    if (this._refs.searchInput) {
      this._refs.searchInput.value = '';
      this._refs.searchInput.focus();
    }
    if (this._refs.searchResults) this._refs.searchResults.innerHTML = '';
  },

  _searchDebounce: null,

  async _handleSearch(query) {
    clearTimeout(this._searchDebounce);
    if (!query || query.length < 2) {
      if (this._refs.searchResults) this._refs.searchResults.innerHTML = '';
      return;
    }

    this._searchDebounce = setTimeout(async () => {
      try {
        const results = await SupabaseService.searchUsers(query);
        const container = this._refs.searchResults;
        if (!container) return;
        container.innerHTML = '';

        if (results.length === 0) {
          container.appendChild(el('p', { class: 'empty-state small', text: 'No users found' }));
          return;
        }

        const user = AppState.get('user');
        const contacts = AppState.get('contacts') || [];
        const contactIds = new Set(contacts.map(c => c.contact?.id));

        for (const r of results) {
          const isContact = contactIds.has(r.id);
          container.appendChild(
            el('div', { class: 'search-result-item' }, [
              this._buildAvatar(r, 'search-avatar'),
              el('div', { class: 'search-info' }, [
                el('span', { class: 'search-name', text: r.display_name || 'Unknown' }),
                el('span', { class: 'search-email', text: r.email || '' }),
              ]),
              isContact
                ? el('span', { class: 'badge', text: 'Contact' })
                : el('button', {
                    class: 'btn btn-sm btn-primary',
                    text: '+ Add',
                    onClick: async (e) => {
                      const btn = e.currentTarget;
                      btn.disabled = true;
                      btn.textContent = '...';
                      try {
                        await SupabaseService.sendContactRequest(user.id, r.id);
                        btn.textContent = 'Sent!';
                        btn.classList.add('btn-success');
                        NotificationService.showToast('Contact request sent!', 'success');
                      } catch (err) {
                        btn.textContent = 'Error';
                        btn.disabled = false;
                        NotificationService.showToast(err.message || 'Failed', 'error');
                      }
                    },
                  }),
            ])
          );
        }
      } catch (err) {
        console.error('[UIRenderer] _handleSearch error:', err);
      }
    }, 300);
  },

  // ═══════════════════════ SETTINGS ═════════════════════════

  _renderSettings() {
    const container = this._refs.settingsView;
    if (!container) return;

    const profile = AppState.get('profile') || {};
    const user = AppState.get('user');

    container.innerHTML = '';

    // Profile section
    const profileSection = el('div', { class: 'settings-section' }, [
      el('h3', { class: 'settings-title', text: '👤 Profile' }),
      el('div', { class: 'settings-profile' }, [
        el('div', {
          class: 'settings-avatar',
          id: 'settings-avatar',
          style: profile.avatar_url
            ? { backgroundImage: `url(${profile.avatar_url})` }
            : { backgroundColor: Utils.stringToColor(profile.display_name || 'U') },
          text: profile.avatar_url ? '' : Utils.getInitials(profile.display_name || 'U'),
          onClick: () => {
            const fi = document.createElement('input');
            fi.type = 'file';
            fi.accept = 'image/*';
            fi.onchange = async () => {
              if (!fi.files[0]) return;
              try {
                NotificationService.showToast('Uploading avatar...', 'info');
                const url = await SupabaseService.uploadAvatar(user.id, fi.files[0]);
                const p = AppState.get('profile');
                AppState.set('profile', { ...p, avatar_url: url });
                this._updateUserProfile();
                this._renderSettings();
                NotificationService.showToast('Avatar updated!', 'success');
              } catch (err) {
                NotificationService.showToast('Avatar upload failed', 'error');
              }
            };
            fi.click();
          },
        }),
        el('div', { class: 'settings-profile-fields' }, [
          this._settingsField('Display Name', profile.display_name || '', async (val) => {
            try {
              const updated = await SupabaseService.updateProfile(user.id, { display_name: val });
              AppState.set('profile', updated);
              this._updateUserProfile();
              NotificationService.showToast('Name updated!', 'success');
            } catch (err) {
              NotificationService.showToast('Update failed', 'error');
            }
          }),
          this._settingsField('Status Message', profile.status_message || '', async (val) => {
            try {
              const updated = await SupabaseService.updateProfile(user.id, { status_message: val });
              AppState.set('profile', updated);
              NotificationService.showToast('Status updated!', 'success');
            } catch (err) {
              NotificationService.showToast('Update failed', 'error');
            }
          }),
        ]),
      ]),
    ]);

    // Appearance section
    const themeSection = el('div', { class: 'settings-section' }, [
      el('h3', { class: 'settings-title', text: '🎨 Appearance' }),
      el('div', { class: 'settings-row' }, [
        el('span', { text: 'Theme' }),
        el('button', {
          class: 'btn btn-sm',
          text: ThemeManager.get() === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode',
          onClick: (e) => {
            ThemeManager.toggle();
            e.currentTarget.textContent = ThemeManager.get() === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
          },
        }),
      ]),
    ]);

    // Notification section
    const notifSection = el('div', { class: 'settings-section' }, [
      el('h3', { class: 'settings-title', text: '🔔 Notifications' }),
      el('div', { class: 'settings-row' }, [
        el('span', { text: 'Sound' }),
        this._toggle(NotificationService.isSoundEnabled(), (on) => {
          NotificationService.setSoundEnabled(on);
        }),
      ]),
      el('div', { class: 'settings-row' }, [
        el('span', { text: 'Desktop Notifications' }),
        this._toggle(NotificationService.isDesktopEnabled(), (on) => {
          NotificationService.setDesktopEnabled(on);
          if (on && NotificationService.getPermission() !== 'granted') {
            NotificationService.requestPermission();
          }
        }),
      ]),
      NotificationService.getPermission() !== 'granted'
        ? el('button', {
            class: 'btn btn-sm btn-primary',
            text: '🔔 Enable Browser Notifications',
            onClick: async (e) => {
              const perm = await NotificationService.requestPermission();
              e.currentTarget.textContent = perm === 'granted' ? '✅ Enabled' : '❌ Denied';
            },
          })
        : null,
    ]);

    // Account section
    const accountSection = el('div', { class: 'settings-section' }, [
      el('h3', { class: 'settings-title', text: '⚙️ Account' }),
      el('div', { class: 'settings-row' }, [
        el('span', { text: user?.email || '' }),
      ]),
      el('button', {
        class: 'btn btn-danger',
        text: '🗑️ Delete Account',
        onClick: async () => {
          if (!confirm('Are you sure? This cannot be undone.')) return;
          if (!confirm('Really delete your account and all data?')) return;
          try {
            await SupabaseService.deleteAccount(user.id);
            Router.navigate('auth');
          } catch (err) {
            NotificationService.showToast('Account deletion failed', 'error');
          }
        },
      }),
      el('button', {
        class: 'btn btn-secondary',
        style: { marginTop: '8px' },
        text: '🚪 Log Out',
        onClick: () => App.logout(),
      }),
    ]);

    container.append(profileSection, themeSection, notifSection, accountSection);
  },

  _settingsField(label, value, onSave) {
    const input = el('input', { class: 'input', value, placeholder: label });
    const saveBtn = el('button', { class: 'btn btn-sm btn-primary', text: 'Save', onClick: () => onSave(input.value.trim()) });
    return el('div', { class: 'settings-field' }, [
      el('label', { text: label }),
      el('div', { class: 'settings-field-row' }, [input, saveBtn]),
    ]);
  },

  _toggle(initial, onChange) {
    const btn = el('button', {
      class: `toggle${initial ? ' active' : ''}`,
      'aria-pressed': String(initial),
      onClick: () => {
        const on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        onChange(on);
      },
    }, [
      el('span', { class: 'toggle-knob' }),
    ]);
    return btn;
  },

  // ═══════════════════════ CONTEXT MENU ═════════════════════

  _showContextMenu(e, msg, isOwn) {
    const menu = this._refs.contextMenu;
    if (!menu || msg._deleted) return;

    this._contextMessage = msg;
    menu.innerHTML = '';

    const items = [];

    // Reply
    items.push({ icon: '↩️', label: 'Reply', action: () => this._setReply(msg) });

    // Copy (only if decrypted)
    if (msg._ok && msg._text) {
      items.push({
        icon: '📋', label: 'Copy',
        action: () => {
          try {
            navigator.clipboard.writeText(msg._text);
            NotificationService.showToast('Copied!', 'success');
          } catch (_) {
            NotificationService.showToast('Copy failed', 'error');
          }
        },
      });
    }

    // Delete for me
    items.push({
      icon: '🗑️', label: 'Delete for me',
      action: () => this._deleteMessage(msg.id, false),
    });

    // Delete for everyone (only own messages)
    if (isOwn) {
      items.push({
        icon: '🗑️', label: 'Delete for everyone',
        action: () => this._deleteMessage(msg.id, true),
      });
    }

    // Block user (not own messages)
    if (!isOwn) {
      items.push({
        icon: '🚫', label: 'Block user',
        action: async () => {
          const user = AppState.get('user');
          if (!user) return;
          try {
            await SupabaseService.blockUser(user.id, msg.sender_id);
            NotificationService.showToast('User blocked', 'info');
          } catch (err) {
            NotificationService.showToast('Failed to block', 'error');
          }
        },
      });
    }

    for (const item of items) {
      menu.appendChild(
        el('button', {
          class: 'context-item',
          onClick: () => {
            menu.hidden = true;
            item.action();
          },
        }, [
          el('span', { text: item.icon }),
          el('span', { text: item.label }),
        ])
      );
    }

    // Position
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - (items.length * 40 + 16));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.hidden = false;
  },

  async _deleteMessage(messageId, forEveryone) {
    const user = AppState.get('user');
    if (!user) return;

    const label = forEveryone ? 'everyone' : 'you';
    if (!confirm(`Delete this message for ${label}?`)) return;

    try {
      await SupabaseService.deleteMessage(messageId, user.id, forEveryone);

      const convId = AppState.get('activeConversationId');
      if (convId) {
        const msgs = AppState.get('messages')[convId] || [];
        if (forEveryone) {
          const idx = msgs.findIndex(m => m.id === messageId);
          if (idx !== -1) {
            msgs[idx] = { ...msgs[idx], status: 'deleted', ciphertext: null, iv: null, deleted_at: new Date().toISOString() };
          }
        } else {
          const filtered = msgs.filter(m => m.id !== messageId);
          AppState.merge('messages', convId, filtered);
        }
        if (forEveryone) AppState.merge('messages', convId, [...msgs]);
        await this.renderMessages(convId, false);
      }

      NotificationService.showToast('Message deleted', 'info');
    } catch (err) {
      console.error('[UIRenderer] _deleteMessage error:', err);
      NotificationService.showToast('Failed to delete', 'error');
    }
  },

  // ═══════════════════════ REPLY ═════════════════════════════

  _setReply(msg) {
    this._replyTo = msg;
    if (this._refs.replyPreview) {
      this._refs.replyPreview.hidden = false;
      const nameEl = this._refs.replyPreview.querySelector('.reply-name');
      const textEl = this._refs.replyPreview.querySelector('.reply-text');
      if (nameEl) nameEl.textContent = msg.sender_id === AppState.get('user')?.id ? 'You' : 'Them';
      if (textEl) textEl.textContent = msg._ok ? (msg._text || '').slice(0, 60) : '🔒 Encrypted';
    }
    if (this._refs.messageInput) this._refs.messageInput.focus();
  },

  _clearReply() {
    this._replyTo = null;
    if (this._refs.replyPreview) this._refs.replyPreview.hidden = true;
  },

  // ═══════════════════════ EMOJI PICKER ═════════════════════

  _showEmojiPicker() {
    const picker = this._refs.emojiPicker;
    if (!picker) return;

    if (!picker.hidden) {
      picker.hidden = true;
      return;
    }

    picker.innerHTML = '';

    // Categories
    const categories = EmojiModule.getCategories();
    const recent = EmojiModule.getRecent();

    const tabBar = el('div', { class: 'emoji-tabs' });
    const content = el('div', { class: 'emoji-content' });

    const renderCategory = (cat, emojis) => {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'emoji-cat-label', text: cat }));
      const grid = el('div', { class: 'emoji-grid' });
      for (const e of emojis) {
        grid.appendChild(
          el('button', {
            class: 'emoji-btn',
            text: e,
            title: e,
            onClick: () => {
              this._insertEmoji(e);
              EmojiModule.addRecent(e);
            },
          })
        );
      }
      content.appendChild(grid);
      $$('.emoji-tab', tabBar).forEach(t => t.classList.toggle('active', t.dataset.cat === cat));
    };

    // Recent tab
    if (recent.length > 0) {
      tabBar.appendChild(
        el('button', { class: 'emoji-tab', text: '🕐', dataset: { cat: 'Recent' }, title: 'Recent', onClick: () => renderCategory('Recent', recent) })
      );
    }

    for (const cat of categories) {
      const first = EmojiModule.getEmojis(cat)[0] || '😀';
      tabBar.appendChild(
        el('button', { class: 'emoji-tab', text: first, dataset: { cat }, title: cat, onClick: () => renderCategory(cat, EmojiModule.getEmojis(cat)) })
      );
    }

    picker.append(tabBar, content);
    picker.hidden = false;

    // Show first category
    if (recent.length > 0) {
      renderCategory('Recent', recent);
    } else {
      renderCategory(categories[0], EmojiModule.getEmojis(categories[0]));
    }
  },

  _insertEmoji(emoji) {
    const input = this._refs.messageInput;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
    this._autoGrowTextarea(input);
  },

  // ═══════════════════════ IMAGE PREVIEW ════════════════════

  _showImagePreview(blob, name) {
    const modal = this._refs.imagePreview;
    if (!modal) return;

    modal.innerHTML = '';
    const url = URL.createObjectURL(blob);
    modal.appendChild(
      el('div', { class: 'image-preview-container' }, [
        el('div', { class: 'image-preview-header' }, [
          el('span', { text: name }),
          el('button', { class: 'btn btn-sm', text: '⬇️ Save', onClick: () => FileModule.saveBlobAs(blob, name) }),
          el('button', { class: 'modal-close', text: '✕', onClick: () => { modal.hidden = true; URL.revokeObjectURL(url); } }),
        ]),
        el('img', { src: url, alt: name, class: 'image-preview-img' }),
      ])
    );
    modal.hidden = false;
  },

  // ═══════════════════════ CHAT HEADER ══════════════════════

  _updateChatHeader(partner) {
    const profile = partner?.profile;
    if (!profile) return;

    if (this._refs.chatPartnerNm) this._refs.chatPartnerNm.textContent = profile.display_name || 'Unknown';

    if (this._refs.chatPartnerAv) {
      if (profile.avatar_url) {
        this._refs.chatPartnerAv.style.backgroundImage = `url(${profile.avatar_url})`;
        this._refs.chatPartnerAv.textContent = '';
      } else {
        this._refs.chatPartnerAv.style.backgroundImage = '';
        this._refs.chatPartnerAv.textContent = Utils.getInitials(profile.display_name || 'U');
        this._refs.chatPartnerAv.style.backgroundColor = Utils.stringToColor(profile.display_name || 'U');
      }
    }

    this._updatePartnerStatus(partner?.user_id);
  },

  _updatePartnerStatus(userId) {
    if (!this._refs.chatPartnerSt || !userId) return;
    const online = AppState.get('onlineUsers');
    if (online.has(userId)) {
      this._refs.chatPartnerSt.textContent = 'Online';
      this._refs.chatPartnerSt.className = 'partner-status online';
    } else {
      this._refs.chatPartnerSt.textContent = 'Offline';
      this._refs.chatPartnerSt.className = 'partner-status offline';
    }
  },

  // ═══════════════════════ TYPING INDICATOR ═════════════════

  _updateTypingIndicator(conversationId) {
    const indicator = this._refs.typingIndicator;
    if (!indicator) return;

    const typing = AppState.get('typingUsers')[conversationId];
    if (!typing || typing.size === 0) {
      indicator.hidden = true;
      return;
    }

    // Resolve names
    const convs = AppState.get('conversations') || [];
    const conv = convs.find(c => c.id === conversationId);
    const names = [];
    for (const uid of typing) {
      const p = conv?.participants?.find(pp => pp.user_id === uid);
      names.push(p?.profile?.display_name || 'Someone');
    }

    indicator.hidden = false;
    const text = names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(', ')} are typing...`;

    indicator.textContent = '';
    indicator.appendChild(el('div', { class: 'typing-dots' }, [
      el('span', { class: 'dot' }), el('span', { class: 'dot' }), el('span', { class: 'dot' }),
    ]));
    indicator.appendChild(document.createTextNode(` ${text}`));
  },

  // ═══════════════════════ CONNECTION BAR ════════════════════

  _updateConnectionBar(status) {
    const bar = this._refs.connectionBar;
    if (!bar) return;

    bar.className = `connection-bar ${status}`;
    const messages = {
      connected: '',
      disconnected: '⚡ You are offline',
      reconnecting: '🔄 Reconnecting...',
    };
    bar.textContent = messages[status] || '';
    bar.hidden = status === 'connected';
  },

  // ═══════════════════════ SCROLL MANAGEMENT ════════════════

  _scrollToBottom(force = false) {
    const container = this._refs.messagesArea;
    if (!container) return;

    if (force || this._isNearBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  },

  _checkScrollPosition() {
    const container = this._refs.messagesArea;
    if (!container) return;

    const threshold = CONFIG.SCROLL_THRESHOLD;
    this._isNearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < threshold;

    // Toggle scroll-to-bottom button
    if (this._refs.scrollBottom) {
      this._refs.scrollBottom.hidden = this._isNearBottom;
    }
  },

  async _handleScrollTop() {
    const container = this._refs.messagesArea;
    if (!container || this._loadingOlder) return;

    if (container.scrollTop < 50) {
      const convId = AppState.get('activeConversationId');
      if (!convId) return;

      const msgs = AppState.get('messages')[convId] || [];
      const pagination = AppState.get('messagePagination')[convId] || {};

      if (!pagination.hasMore || pagination.loading) return;

      const oldest = msgs[0];
      if (!oldest) return;

      this._loadingOlder = true;
      await this._loadMessages(convId, oldest.created_at);
      // Note: _loadMessages already calls renderMessages internally
      this._loadingOlder = false;
    }
  },

  // ═══════════════════════ SIDEBAR ═══════════════════════════

  _toggleSidebar() {
    const open = !AppState.get('sidebarOpen');
    AppState.set('sidebarOpen', open);
    if (this._refs.sidebar) this._refs.sidebar.classList.toggle('open', open);
    if (this._refs.sidebarOverlay) this._refs.sidebarOverlay.hidden = !open;
  },

  _closeSidebar() {
    AppState.set('sidebarOpen', false);
    if (this._refs.sidebar) this._refs.sidebar.classList.remove('open');
    if (this._refs.sidebarOverlay) this._refs.sidebarOverlay.hidden = true;
  },

  // ═══════════════════════ HELPERS ═══════════════════════════

  _buildAvatar(profile, className = 'avatar', showOnline = false) {
    const name = profile?.display_name || 'U';
    const wrapper = el('div', { class: `${className}-wrapper` });
    const av = el('div', { class: className });

    if (profile?.avatar_url) {
      av.style.backgroundImage = `url(${profile.avatar_url})`;
    } else {
      av.textContent = Utils.getInitials(name);
      av.style.backgroundColor = Utils.stringToColor(name);
    }

    wrapper.appendChild(av);
    if (showOnline) {
      wrapper.appendChild(el('span', { class: 'online-dot' }));
    }
    return wrapper;
  },

  _getPartner(conv) {
    const userId = AppState.get('user')?.id;
    if (!conv?.participants) return null;
    return conv.participants.find(p => p.user_id !== userId) || conv.participants[0];
  },

  async _ensureSalt(conversationId, conv) {
    let salt = AppState.get('passkeySalts')[conversationId];
    if (salt) return salt;

    salt = conv?.encryption_salt;
    if (!salt) {
      try {
        salt = await SupabaseService.getConversationSalt(conversationId);
      } catch (err) {
        console.warn('[UIRenderer] _ensureSalt fetch error:', err);
      }
    }
    if (!salt) {
      salt = CryptoEngine.generateSalt();
    }

    AppState.merge('passkeySalts', conversationId, salt);
    return salt;
  },

  _showFieldError(refKey, msg) {
    const el = this._refs[refKey];
    if (el) el.textContent = msg;
  },

  _setButtonLoading(refKey, loading) {
    const btn = this._refs[refKey];
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn._origText = btn.textContent;
      btn.textContent = '...';
    } else {
      btn.textContent = btn._origText || btn.textContent;
    }
  },

  _autoGrowTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  },

  _closeAllPopups() {
    if (this._refs.contextMenu) this._refs.contextMenu.hidden = true;
    if (this._refs.emojiPicker) this._refs.emojiPicker.hidden = true;
  },

  // ═══════════════════════ DOM EVENT BINDINGS ════════════════

  _bindDOMEvents() {
    // ── Auth forms ──
    this._refs.loginForm?.addEventListener('submit', (e) => this.handleLogin(e));
    this._refs.registerForm?.addEventListener('submit', (e) => this.handleRegister(e));

    // Auth toggle
    $('#auth-toggle-login')?.addEventListener('click', () => this.showLoginForm());
    $('#auth-toggle-register')?.addEventListener('click', () => this.showRegisterForm());

    // Password validation feedback
    this._refs.regPassword?.addEventListener('input', (e) => {
      const pw = e.target.value;
      const checks = Utils.validatePassword(pw);
      const strength = CryptoEngine.measureStrength(pw);

      if (this._refs.pwStrength) {
        this._refs.pwStrength.style.width = `${(strength.score + 1) * 20}%`;
        this._refs.pwStrength.style.backgroundColor = strength.color;
      }
      if (this._refs.pwChecks) {
        const items = this._refs.pwChecks.querySelectorAll('.pw-check');
        const keys = ['length', 'upper', 'lower', 'number', 'special'];
        items.forEach((item, i) => {
          item.classList.toggle('pass', checks.checks[keys[i]]);
        });
      }
    });

    // ── Sidebar navigation ──
    $$('.sidebar-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.showSidebarView(btn.dataset.view);
      });
    });

    // Sidebar toggle (mobile)
    $('#sidebar-toggle')?.addEventListener('click', () => this._toggleSidebar());
    this._refs.sidebarOverlay?.addEventListener('click', () => this._closeSidebar());

    // New chat button
    $('#new-chat-btn')?.addEventListener('click', () => {
      this.showSidebarView('contacts');
    });

    // ── Conversation list delegation ──
    this._refs.convList?.addEventListener('click', (e) => {
      const item = e.target.closest('.conv-item');
      if (item?.dataset.convId) {
        this.openConversation(item.dataset.convId);
      }
    });

    // ── Message input ──
    this._refs.messageInput?.addEventListener('input', (e) => {
      this._autoGrowTextarea(e.target);
      const convId = AppState.get('activeConversationId');
      if (convId) RealtimeManager.startTyping(convId);
    });

    this._refs.messageInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    // Send button
    this._refs.sendBtn?.addEventListener('click', () => this.handleSendMessage());

    // ── Attachment ──
    $('#attach-btn')?.addEventListener('click', () => {
      if (!this._refs.fileInput) return;
      this._refs.fileInput.value = '';
      this._refs.fileInput.click();
    });

    this._refs.fileInput?.addEventListener('change', () => {
      const file = this._refs.fileInput?.files[0];
      if (file) this.handleFileSend(file);
    });

    // ── Emoji toggle ──
    $('#emoji-btn')?.addEventListener('click', () => this._showEmojiPicker());

    // ── Passkey modal ──
    $('#passkey-submit')?.addEventListener('click', () => this._handlePasskeySubmit());
    this._refs.passkeyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handlePasskeySubmit();
    });
    this._refs.passkeyInput?.addEventListener('input', (e) => {
      const strength = CryptoEngine.measureStrength(e.target.value);
      if (this._refs.passkeyStrength) {
        this._refs.passkeyStrength.style.width = `${(strength.score + 1) * 20}%`;
        this._refs.passkeyStrength.style.backgroundColor = strength.color;
      }
    });
    $('#passkey-cancel')?.addEventListener('click', () => {
      if (this._refs.passkeyModal) this._refs.passkeyModal.hidden = true;
    });

    // Change passkey button in chat header
    $('#change-passkey-btn')?.addEventListener('click', () => {
      const convId = AppState.get('activeConversationId');
      if (convId) this._showPasskeyModal(convId);
    });

    // ── Search modal ──
    this._refs.searchInput?.addEventListener('input', (e) => this._handleSearch(e.target.value.trim()));
    $('#search-close')?.addEventListener('click', () => {
      if (this._refs.searchModal) this._refs.searchModal.hidden = true;
    });

    // ── Reply cancel ──
    $('#reply-cancel')?.addEventListener('click', () => this._clearReply());

    // ── Scroll ──
    this._refs.messagesArea?.addEventListener('scroll', Utils.throttle(() => {
      this._checkScrollPosition();
      this._handleScrollTop();
    }, 100));

    this._refs.scrollBottom?.addEventListener('click', () => this._scrollToBottom(true));

    // ── Back button (mobile) ──
    $('#chat-back-btn')?.addEventListener('click', async () => {
      const convId = AppState.get('activeConversationId');
      if (convId) {
        await RealtimeManager.leaveConversation(convId);
      }
      if (this._refs.chatEmpty) this._refs.chatEmpty.hidden = false;
      if (this._refs.chatActive) this._refs.chatActive.hidden = true;
      this._toggleSidebar();
    });

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', (e) => {
      // Escape → close popups/modals
      if (e.key === 'Escape') {
        this._closeAllPopups();
        if (this._refs.passkeyModal && !this._refs.passkeyModal.hidden) {
          this._refs.passkeyModal.hidden = true;
        }
        if (this._refs.searchModal && !this._refs.searchModal.hidden) {
          this._refs.searchModal.hidden = true;
        }
        if (this._refs.imagePreview && !this._refs.imagePreview.hidden) {
          this._refs.imagePreview.hidden = true;
        }
      }

      // Ctrl/Cmd+K → search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.showSidebarView('contacts');
        this._showSearchModal();
      }
    });

    // ── Close context menu / emoji picker on outside click ──
    document.addEventListener('click', (e) => {
      if (this._refs.contextMenu && !this._refs.contextMenu.hidden) {
        if (!this._refs.contextMenu.contains(e.target)) {
          this._refs.contextMenu.hidden = true;
        }
      }
      if (this._refs.emojiPicker && !this._refs.emojiPicker.hidden) {
        const emojiBtn = $('#emoji-btn');
        if (!this._refs.emojiPicker.contains(e.target) && e.target !== emojiBtn && !emojiBtn?.contains(e.target)) {
          this._refs.emojiPicker.hidden = true;
        }
      }
    });

    // Close modals on overlay click
    $$('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.closest('.modal')?.setAttribute('hidden', '');
        }
      });
    });

    // ── Window resize → sidebar state ──
    window.addEventListener('resize', Utils.debounce(() => {
      if (window.innerWidth > 768) {
        AppState.set('sidebarOpen', true);
        if (this._refs.sidebar) this._refs.sidebar.classList.add('open');
        if (this._refs.sidebarOverlay) this._refs.sidebarOverlay.hidden = true;
      }
    }, 200));

    // Logout button
    $('#logout-btn')?.addEventListener('click', () => App.logout());

    // Theme toggle in header
    $('#theme-toggle')?.addEventListener('click', () => ThemeManager.toggle());
  },

  // ═══════════════════════ STATE WATCHERS ════════════════════

  _bindStateWatchers() {
    this._unsubs.push(
      AppState.watch('connectionStatus', (status) => this._updateConnectionBar(status))
    );

    this._unsubs.push(
      AppState.watch('conversations', () => this.renderConversations())
    );

    this._unsubs.push(
      AppState.watch('unreadCounts', () => this.renderConversations())
    );

    this._unsubs.push(
      AppState.watch('onlineUsers', () => {
        this.renderConversations();
        const convId = AppState.get('activeConversationId');
        if (convId) {
          const convs = AppState.get('conversations') || [];
          const conv = convs.find(c => c.id === convId);
          const partner = this._getPartner(conv);
          if (partner) this._updatePartnerStatus(partner.user_id);
        }
      })
    );

    this._unsubs.push(
      AppState.watch('profile', () => this._updateUserProfile())
    );

    this._unsubs.push(
      AppState.watch('sidebarOpen', (open) => {
        if (this._refs.sidebar) this._refs.sidebar.classList.toggle('open', open);
        if (this._refs.sidebarOverlay) this._refs.sidebarOverlay.hidden = !open || window.innerWidth > 768;
      })
    );
  },

  // ═══════════════════════ EVENTBUS LISTENERS ════════════════

  _bindEventBusListeners() {
    // New message → re-render if active
    this._unsubs.push(
      eventBus.on('message:received', async ({ conversationId }) => {
        if (conversationId === AppState.get('activeConversationId')) {
          await this.renderMessages(conversationId, true);
        }
      })
    );

    // Own message confirmed by server
    this._unsubs.push(
      eventBus.on('message:sent:confirmed', async ({ message }) => {
        const convId = message.conversation_id;
        this._replaceOptimistic(convId, message.idempotency_key, message);
        if (convId === AppState.get('activeConversationId')) {
          await this.renderMessages(convId, false);
        }
      })
    );

    // Message updated (e.g. deleted for everyone)
    this._unsubs.push(
      eventBus.on('message:updated', async ({ conversationId }) => {
        if (conversationId === AppState.get('activeConversationId')) {
          await this.renderMessages(conversationId, false);
        }
      })
    );

    // Message deleted
    this._unsubs.push(
      eventBus.on('message:deleted', async ({ conversationId }) => {
        if (conversationId === AppState.get('activeConversationId')) {
          await this.renderMessages(conversationId, false);
        }
      })
    );

    // Typing indicator
    this._unsubs.push(
      eventBus.on('typing:update', ({ conversationId }) => {
        if (conversationId === AppState.get('activeConversationId')) {
          this._updateTypingIndicator(conversationId);
        }
      })
    );

    // Contacts refresh
    this._unsubs.push(
      eventBus.on('contacts:refresh', () => {
        if (AppState.get('activeView') === 'contacts') {
          this._loadContacts();
        }
      })
    );

    // Conversations refresh
    this._unsubs.push(
      eventBus.on('conversations:refresh', async () => {
        try {
          const user = AppState.get('user');
          if (!user) return;
          const convs = await SupabaseService.getConversations(user.id);
          AppState.set('conversations', convs);
        } catch (err) {
          console.warn('[UIRenderer] conversations:refresh error:', err);
        }
      })
    );

    // Conversations updated (new message in any conv → reorder list)
    this._unsubs.push(
      eventBus.on('conversations:updated', () => {
        eventBus.emit('conversations:refresh');
      })
    );

    // Navigate to conversation (from notification click)
    this._unsubs.push(
      eventBus.on('navigate:conversation', ({ conversationId }) => {
        this.showSidebarView('chats');
        this.openConversation(conversationId);
      })
    );

    // Session reset → back to auth
    this._unsubs.push(
      eventBus.on('state:reset', () => {
        this.showAuth();
        Router.navigate('auth');
      })
    );

    // Error handler
    this._unsubs.push(
      eventBus.on('error', ({ message }) => {
        NotificationService.showToast(message || 'An error occurred', 'error');
      })
    );
  },

  // ═══════════════════════ CLEANUP ═══════════════════════════

  cleanup() {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) {}
    }
    this._unsubs = [];
  },
};


// ─────────────────────────────────────────────────────────────
//  APP BOOTSTRAP
// ─────────────────────────────────────────────────────────────
const App = {

  /** @type {Function|null} auth listener unsub */
  _authUnsub: null,

  async init() {
    console.log('[App] Initializing SecureChat...');

    try {
      // 1. Init Supabase
      SupabaseService.init();

      // 2. Theme
      ThemeManager.init();

      // 3. Router
      Router.init();
      Router.register('auth', () => UIRenderer.showAuth());
      Router.register('chat', () => UIRenderer.showSidebarView('chats'));
      Router.register('contacts', () => UIRenderer.showSidebarView('contacts'));
      Router.register('settings', () => UIRenderer.showSidebarView('settings'));

      // 4. UI
      UIRenderer.init();

      // 5. Check existing session
      UIRenderer.showLoading(true);

      let session = null;
      try {
        session = await SupabaseService.getSession();
      } catch (err) {
        console.warn('[App] getSession error:', err);
      }

      if (session?.user) {
        AppState.batch({ user: session.user, session });
        await this.loadUserData(session.user);
        UIRenderer.showApp();
        Router.navigate('chat');
      } else {
        UIRenderer.showAuth();
        Router.navigate('auth');
      }

      UIRenderer.showLoading(false);

      // 6. Auth state listener
      this._authUnsub = SupabaseService.onAuthStateChange((event, session) => {
        this._handleAuthChange(event, session);
      });

      // 7. Notification service
      NotificationService.init();

      // 8. Connectivity
      ConnectivityManager.init();

      AppState.set('initialized', true);
      console.log('[App] SecureChat initialized successfully');

    } catch (err) {
      console.error('[App] Initialization error:', err);
      UIRenderer.showLoading(false);
      UIRenderer.showAuth();
      NotificationService.showToast('App initialization failed. Please refresh.', 'error', 0);
    }
  },

  async loadUserData(user) {
    if (!user?.id) return;

    try {
      // Load profile
      let profile = null;
      try {
        profile = await SupabaseService.getProfile(user.id);
      } catch (err) {
        console.warn('[App] getProfile error:', err);
        // Profile might not exist yet — first login
        profile = { id: user.id, display_name: user.user_metadata?.display_name || 'User' };
      }
      AppState.set('profile', profile);

      // Load conversations
      try {
        const convs = await SupabaseService.getConversations(user.id);
        AppState.set('conversations', convs);
      } catch (err) {
        console.warn('[App] getConversations error:', err);
      }

      // Load unread counts
      try {
        const convs = AppState.get('conversations') || [];
        const counts = {};
        for (const conv of convs) {
          try {
            counts[conv.id] = await SupabaseService.getUnreadCount(conv.id, user.id);
          } catch (_) {
            counts[conv.id] = 0;
          }
        }
        AppState.set('unreadCounts', counts);
        AppState.set('totalUnread', Object.values(counts).reduce((a, b) => a + b, 0));
      } catch (err) {
        console.warn('[App] unread counts error:', err);
      }

      // Init realtime manager
      RealtimeManager.init(user.id);

      // Load user statuses for contacts
      try {
        const contacts = await SupabaseService.getContacts(user.id);
        AppState.set('contacts', contacts);
        const contactIds = contacts.map(c => c.contact?.id).filter(Boolean);
        if (contactIds.length > 0) {
          const statuses = await SupabaseService.getUserStatuses(contactIds);
          const onlineSet = new Set();
          for (const s of statuses) {
            if (s.status === 'online') onlineSet.add(s.user_id);
          }
          AppState.set('onlineUsers', onlineSet);
        }
      } catch (err) {
        console.warn('[App] contact statuses error:', err);
      }

      // Render
      UIRenderer.renderConversations();

    } catch (err) {
      console.error('[App] loadUserData error:', err);
      NotificationService.showToast('Failed to load user data', 'error');
    }
  },

  _handleAuthChange(event, session) {
    try {
      switch (event) {
        case 'SIGNED_IN':
          if (session?.user && !AppState.get('user')) {
            AppState.batch({ user: session.user, session });
            this.loadUserData(session.user).then(() => {
              UIRenderer.showApp();
              Router.navigate('chat');
            });
          }
          break;

        case 'SIGNED_OUT':
          this.cleanup();
          UIRenderer.showAuth();
          Router.navigate('auth');
          break;

        case 'TOKEN_REFRESHED':
          if (session) {
            AppState.set('session', session);
          }
          break;

        case 'USER_UPDATED':
          if (session?.user) {
            AppState.set('user', session.user);
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('[App] _handleAuthChange error:', err);
    }
  },

  async logout() {
    try {
      this.cleanup();
      await SupabaseService.signOut();
    } catch (err) {
      console.error('[App] logout error:', err);
      // Force cleanup even if signOut fails
      AppState.reset();
    }
    UIRenderer.showAuth();
    Router.navigate('auth');
  },

  cleanup() {
    try { RealtimeManager.cleanup(); } catch (_) {}
    try { ConnectivityManager.cleanup(); } catch (_) {}
    try { NotificationService.cleanup(); } catch (_) {}
    try { UIRenderer.cleanup(); } catch (_) {}
    CryptoEngine.clearKeys();
  },
};


// ─────────────────────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}

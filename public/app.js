const TZ = 'Asia/Tashkent';
const list = document.getElementById('chat-list');
const pane = document.getElementById('chat-pane');

let active = null;
let chats = [];
let selected = new Set();
let dragging = false;
let dragMode = null;     // 'add' | 'remove' — fixed once first row is touched
let dragChain = [];      // ordered [{ id, original }] of rows visited in this drag
let cursorY = 0;
let autoScrollBox = null;
let autoScrollSpeed = 0;
let autoScrollTimer = null;

// ---- Utilities ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function linkify(text) {
  return esc(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
}

function initial(name) {
  for (const ch of String(name || '').trim()) {
    if (/\p{L}/u.test(ch)) return ch.toUpperCase();
  }
  return '?';
}

function avatar(name, seed) {
  const h = (Math.abs(seed) * 47) % 360;
  return `<div class="avatar" style="background:linear-gradient(135deg,hsl(${h} 65% 58%),hsl(${(h + 35) % 360} 65% 46%))">${esc(initial(name))}</div>`;
}

// ---- Time (Asia/Tashkent, 24-hour) ----
function toDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return isNaN(d) ? null : d;
}

function fmt(value, opts) {
  const d = toDate(value);
  return d ? d.toLocaleString('en-GB', { timeZone: TZ, hour12: false, ...opts }) : '';
}

function time24(value) {
  return fmt(value, { hour: '2-digit', minute: '2-digit' });
}

function dayKey(value) {
  const d = toDate(value);
  return d ? d.toLocaleDateString('en-CA', { timeZone: TZ }) : '';
}

function sidebarTime(ts) {
  return dayKey(ts) === dayKey(new Date())
    ? time24(ts)
    : fmt(ts, { day: '2-digit', month: 'short' });
}

function dateSeparator(ts) {
  const key = dayKey(ts);
  const today = dayKey(new Date());
  if (key === today) return 'Today';
  if (key === dayKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  const opts = { day: 'numeric', month: 'long' };
  if (key.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return fmt(ts, opts);
}

// ---- Chat metadata helpers ----
function chatTitle(chat) {
  if (chat.type === 'private') {
    return [chat.first_name, chat.last_name].filter(Boolean).join(' ')
      || chat.username
      || `Chat ${chat.chat_id}`;
  }
  return chat.title || (chat.chat_id < 0 ? 'Group' : `Chat ${chat.chat_id}`);
}

function chatSubtitle(chat) {
  const kind = chat.type === 'private'
    ? (chat.username ? '@' + chat.username : '')
    : (chat.type || 'group');
  return [kind, `ID: ${chat.chat_id}`, `${chat.msg_count} messages`]
    .filter(Boolean)
    .join(' · ');
}

// ---- Rendering ----
async function loadChats() {
  try {
    const res = await fetch('/api/chats');
    chats = await res.json();
    list.innerHTML = chats.map(chatItem).join('');
    list.querySelectorAll('.chat-item').forEach(el =>
      el.addEventListener('click', () => selectChat(Number(el.dataset.id)))
    );
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

function chatItem(chat) {
  const title = chatTitle(chat);
  const preview = esc((chat.last_text || '').replace(/\s+/g, ' ').slice(0, 80));
  return `
    <div class="chat-item" data-id="${chat.chat_id}">
      ${avatar(title, chat.chat_id)}
      <div class="chat-meta">
        <div class="head"><span class="name">${esc(title)}</span><span class="time">${sidebarTime(chat.last_timestamp)}</span></div>
        <div class="preview">${preview}</div>
      </div>
    </div>`;
}

function setActiveChat(chatId) {
  list.querySelectorAll('.chat-item').forEach(el =>
    el.classList.toggle('active', Number(el.dataset.id) === chatId)
  );
}

async function selectChat(chatId) {
  if (active === chatId) return;
  active = chatId;
  selected.clear();
  setActiveChat(chatId);

  const chat = chats.find(c => c.chat_id === chatId);
  if (!chat) return;
  const title = chatTitle(chat);

  pane.innerHTML = `
    <div class="header">
      ${avatar(title, chat.chat_id)}
      <div class="title-wrap">
        <div class="title">${esc(title)}</div>
        <div class="subtitle">${esc(chatSubtitle(chat))}</div>
      </div>
      <div class="sel-bar" id="sel-bar"></div>
    </div>
    <div class="messages" id="msgs"><div class="empty">Loading…</div></div>`;

  attachSelectionHandlers(document.getElementById('msgs'));
  await loadMessages(chatId, 'bottom');
}

async function loadMessages(chatId, scroll) {
  const msgs = document.getElementById('msgs');
  if (!msgs) return;
  const savedTop = scroll === 'preserve' ? msgs.scrollTop : 0;
  try {
    const res = await fetch(`/api/messages/${chatId}`);
    if (active !== chatId) return; // user switched chats while fetching
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (active !== chatId) return;
    const chat = chats.find(c => c.chat_id === chatId);
    renderMessages(data, chat?.type !== 'private');
    requestAnimationFrame(() => {
      msgs.scrollTop = scroll === 'bottom' ? msgs.scrollHeight : savedTop;
    });
  } catch (err) {
    msgs.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

function renderReply(msg, byId) {
  if (!msg.reply_to_id) return '';
  const text = (byId.get(msg.reply_to_id)?.text || '').trim();
  return text ? `<div class="reply">${esc(text)}</div>` : '';
}

function renderReactions(raw) {
  if (!raw) return '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return ''; }
  const items = Object.entries(parsed).filter(([emoji, users]) =>
    emoji && Array.isArray(users) && users.length
  );
  if (!items.length) return '';
  return `<div class="reactions">${items
    .map(([emoji, users]) => `<span class="chip">${esc(emoji)} ${users.length}</span>`)
    .join('')}</div>`;
}

function renderMessages(messages, isGroup) {
  const msgs = document.getElementById('msgs');
  if (!msgs) return;
  if (!messages.length) {
    msgs.innerHTML = '<div class="empty">No messages</div>';
    return;
  }

  const byId = new Map(messages.map(m => [m.message_id, m]));
  let lastDay = null;
  let lastRun = null;
  const parts = [];

  for (const msg of messages) {
    const key = dayKey(msg.timestamp);
    if (key !== lastDay) {
      parts.push(`<div class="date-pill">${esc(dateSeparator(msg.timestamp))}</div>`);
      lastDay = key;
      lastRun = null;
    }
    const dir = msg.direction === 'out' ? 'out' : 'in';
    const run = `${dir}:${msg.user_id}`;
    const showSender = isGroup && dir === 'in' && run !== lastRun && msg.first_name;
    const sel = selected.has(msg.message_id) ? ' selected' : '';
    const del = msg.deleted ? ' deleted' : '';
    const status = msg.deleted ? 'deleted' : msg.edited ? 'edited' : '';
    parts.push(`<div class="row ${dir}${sel}${del}" data-id="${msg.message_id}"><div class="bubble">
      ${showSender ? `<div class="sender">${esc(msg.first_name)}</div>` : ''}
      ${renderReply(msg, byId)}
      <span class="text">${linkify(msg.text || '')}</span>
      ${renderReactions(msg.reactions)}
      <span class="meta">${status ? `<span class="ed">${status}</span>` : ''}<span>${time24(msg.timestamp)}</span></span>
    </div></div>`);
    lastRun = run;
  }

  msgs.innerHTML = parts.join('');
}

// ---- Selection & delete ----
function setSelected(id, on) {
  if (on) selected.add(id);
  else selected.delete(id);
  const row = document.querySelector(`.row[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', on);
  updateSelBar();
}

function clearSelection() {
  selected.clear();
  document.querySelectorAll('.row.selected').forEach(el => el.classList.remove('selected'));
  updateSelBar();
}

function updateSelBar() {
  const bar = document.getElementById('sel-bar');
  if (!bar) return;
  if (selected.size === 0) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = `<span class="sel-count">${selected.size} selected</span><button class="btn btn-danger" id="btn-del">Delete</button><button class="btn" id="btn-cancel">Cancel</button>`;
  bar.querySelector('#btn-del').onclick = deleteSelected;
  bar.querySelector('#btn-cancel').onclick = clearSelection;
}

async function deleteSelected() {
  if (selected.size === 0 || active === null) return;
  const n = selected.size;
  if (!confirm(`Delete ${n} message${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const ids = [...selected];
  const chatId = active;
  try {
    const res = await fetch('/api/delete-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_ids: ids }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    selected.clear();
    updateSelBar();
    await loadChats();
    setActiveChat(chatId);
    await loadMessages(chatId, 'preserve');
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// First touched row fixes the mode (add/remove); dragging back past visited
// rows reverts them. Events INSIDE .bubble are left to the browser (text
// select, link clicks); everything else in the row participates in selection.
function applyDrag(row) {
  if (!row) return;
  const id = Number(row.dataset.id);
  const idx = dragChain.findIndex(entry => entry.id === id);
  if (idx === -1) {
    const wasSelected = selected.has(id);
    if (dragMode === null) dragMode = wasSelected ? 'remove' : 'add';
    dragChain.push({ id, original: wasSelected });
    setSelected(id, dragMode === 'add');
  } else if (idx < dragChain.length - 1) {
    for (let i = dragChain.length - 1; i > idx; i--) {
      setSelected(dragChain[i].id, dragChain[i].original);
    }
    dragChain.length = idx + 1;
  }
}

function endDrag() {
  dragging = false;
  dragMode = null;
  dragChain = [];
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
  autoScrollBox = null;
  autoScrollSpeed = 0;
}

function attachSelectionHandlers(msgs) {
  if (!msgs) return;
  msgs.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.bubble') || e.target.closest('a')) return;
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    e.preventDefault();
    dragging = true;
    dragMode = null;
    dragChain = [];
    autoScrollBox = msgs;
    cursorY = e.clientY;
    applyDrag(row);
  });
  msgs.addEventListener('mouseover', e => {
    if (!dragging) return;
    const row = e.target.closest('.row[data-id]');
    if (row) applyDrag(row);
  });
}

document.addEventListener('mousemove', e => {
  cursorY = e.clientY;
  if (!dragging || !autoScrollBox) return;
  const rect = autoScrollBox.getBoundingClientRect();
  const margin = 80;
  autoScrollSpeed =
    cursorY < rect.top || cursorY > rect.bottom ? 0 :
    cursorY < rect.top + margin ? -Math.max(4, Math.ceil((rect.top + margin - cursorY) / 4)) :
    cursorY > rect.bottom - margin ? Math.max(4, Math.ceil((cursorY - (rect.bottom - margin)) / 4)) : 0;
  if (autoScrollSpeed !== 0 && !autoScrollTimer) {
    autoScrollTimer = setInterval(() => {
      if (autoScrollBox && autoScrollSpeed) autoScrollBox.scrollTop += autoScrollSpeed;
    }, 16);
  }
});

document.addEventListener('mouseup', () => { if (dragging) endDrag(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selected.size > 0) clearSelection();
});

loadChats();

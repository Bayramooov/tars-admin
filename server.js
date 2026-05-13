const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DB_DIR = path.resolve(__dirname, process.env.DB_DIR || '.');
const DB_FILE = process.env.DB_FILE || 'pyclaudir.db';
const DB_PATH = path.resolve(DB_DIR, DB_FILE);
const PORT = Number(process.env.PORT) || 3000;
const db = new Database(DB_PATH, { readonly: true });

function chatField(key) {
  return `MAX(json_extract(raw_update_json, '$.message.chat.${key}'))`;
}

const chatsQuery = db.prepare(`
  WITH meta AS (
    SELECT chat_id,
      ${chatField('type')}       AS type,
      ${chatField('title')}      AS title,
      ${chatField('first_name')} AS first_name,
      ${chatField('last_name')}  AS last_name,
      ${chatField('username')}   AS username,
      COUNT(*)                   AS msg_count,
      MAX(timestamp)             AS last_ts
    FROM messages GROUP BY chat_id
  )
  SELECT meta.*,
    m.text       AS last_text,
    m.direction  AS last_direction,
    m.first_name AS last_sender,
    m.deleted    AS last_deleted,
    m.timestamp  AS last_timestamp
  FROM meta
  JOIN messages m ON m.chat_id = meta.chat_id AND m.timestamp = meta.last_ts
  GROUP BY meta.chat_id
  ORDER BY meta.last_ts DESC
`);

const messagesQuery = db.prepare(`
  SELECT message_id, user_id, first_name, direction, timestamp, text,
         reply_to_id, reply_to_text, edited, deleted, reactions
  FROM messages WHERE chat_id = ? ORDER BY timestamp, message_id
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/chats', (_req, res) => res.json(chatsQuery.all()));
app.get('/api/messages/:id', (req, res) => res.json(messagesQuery.all(Number(req.params.id))));

// Opens a write connection only for this request. PK is (chat_id, message_id).
app.post('/api/delete-messages', (req, res) => {
  const chatId = Number(req.body?.chat_id);
  const ids = (Array.isArray(req.body?.message_ids) ? req.body.message_ids : []).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(chatId) || ids.length === 0) {
    return res.status(400).json({ error: 'chat_id (number) and non-empty message_ids required' });
  }
  const writer = new Database(DB_PATH);
  try {
    const placeholders = ids.map(() => '?').join(',');
    const info = writer.prepare(`DELETE FROM messages WHERE chat_id = ? AND message_id IN (${placeholders})`).run(chatId, ...ids);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    writer.close();
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

/* ============================================================================
 * BRIDGE TV admin panel — Supabase client
 *
 * Drop-in replacement for the Firebase calls the admin panel used to make.
 * Rows coming back from Supabase (snake_case columns) are translated to the
 * same camelCase shape the existing render code already expects
 * (message, user, displayName, smsType, ts, source, senderRole, approved,
 * status), so renderLog(), renderInbox(), messageMeta() etc. do not need to
 * change at all.
 *
 * Load AFTER:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 * and BEFORE your own <script> block that calls window.btv.*
 * ========================================================================== */

const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co'; // TODO: свой проект Supabase для RUSONG
const SUPABASE_PUBLISHABLE_KEY = 'YOUR_PUBLISHABLE_KEY'; // Settings → API Keys → Publishable key

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function rowToMessage(r) {
  return {
    key: r.id,
    message: r.message || '',
    user: r.user_name || '',
    displayName: r.display_name || r.user_name || '',
    smsType: r.sms_type || 'normal',
    ts: r.ts || 0,
    source: r.source || r.sender_role || 'moderator',
    senderRole: r.sender_role || r.source || 'moderator'
  };
}

function rowToInbox(r) {
  return {
    key: r.id,
    message: r.message || '',
    user: r.user_name || '',
    displayName: r.display_name || r.user_name || '',
    smsType: r.sms_type || 'normal',
    ts: r.ts || 0,
    approved: r.approved || false,
    status: r.status || (r.approved ? 'approved' : 'pending'),
    source: r.source || r.sender_role || 'viewer',
    senderRole: r.sender_role || r.source || 'viewer'
  };
}

/* ── Auth ─────────────────────────────────────────────────────────────── */

function onAuthChange(callback) {
  sb.auth.getSession().then(({ data }) => callback(data.session ? data.session.user : null));
  sb.auth.onAuthStateChange((_event, session) => callback(session ? session.user : null));
}

function signIn(email, password) {
  return sb.auth.signInWithPassword({ email, password });
}

function signOut() {
  return sb.auth.signOut();
}

/* ── Connection status (best-effort equivalent of .info/connected) ─────── */

function watchConnection(onChange) {
  // supabase-js does not expose a single global connection flag the way
  // Firebase did; the realtime channel status callbacks below (see
  // subscribeMessages/subscribeInbox) are the practical equivalent. This
  // helper just reflects the browser's own online/offline state as a
  // reasonable fallback for the connection dot.
  onChange(navigator.onLine);
  window.addEventListener('online', () => onChange(true));
  window.addEventListener('offline', () => onChange(false));
}

/* ── Messages (public on-air feed) ──────────────────────────────────────
 * onChange(allRows) is called with the FULL current set every time
 * something changes, same as Firebase's db.ref('messages').on('value').
 * ------------------------------------------------------------------------ */

async function subscribeMessages(onChange) {
  async function reload() {
    const { data, error } = await sb.from('messages').select('*').order('ts', { ascending: false });
    if (!error) onChange(data.map(rowToMessage));
  }
  await reload();
  return sb
    .channel('messages-admin')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, reload)
    .subscribe();
}

async function sendMessage({ message, user, displayName, smsType }) {
  const { error } = await sb.from('messages').insert({
    message,
    user_name: user,
    display_name: displayName || user || 'BTV',
    sms_type: smsType,
    source: 'moderator',
    sender_role: 'moderator',
    ts: Date.now()
  });
  if (error) throw error;
}

async function deleteMessage(id) {
  const { error } = await sb.from('messages').delete().eq('id', id);
  if (error) throw error;
}

async function clearAllMessages() {
  // Deletes every row; "id is not null" is required because Supabase
  // rejects an unfiltered delete.
  const { error } = await sb.from('messages').delete().not('id', 'is', null);
  if (error) throw error;
}

/* ── Inbox (moderation queue) ───────────────────────────────────────────
 * Same "full snapshot on every change" shape as subscribeMessages above.
 * ------------------------------------------------------------------------ */

async function subscribeInbox(onChange) {
  async function reload() {
    const { data, error } = await sb.from('inbox').select('*').order('ts', { ascending: false });
    if (!error) onChange(data.map(rowToInbox));
  }
  await reload();
  return sb
    .channel('inbox-admin')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox' }, reload)
    .subscribe();
}

async function approveInboxEntry(entry) {
  const { error: insertError } = await sb.from('messages').insert({
    message: entry.message,
    user_name: entry.user,
    display_name: entry.displayName || entry.user || '',
    sms_type: entry.smsType,
    source: entry.source || 'viewer',
    sender_role: entry.senderRole || entry.source || 'viewer',
    ts: Date.now(),
    inbox_id: entry.key
  });
  if (insertError) throw insertError;

  const { error: updateError } = await sb
    .from('inbox')
    .update({ approved: true, status: 'approved', approved_at: Date.now() })
    .eq('id', entry.key);
  if (updateError) throw updateError;
}

async function rejectInboxEntry(id) {
  const { error } = await sb
    .from('inbox')
    .update({ approved: false, status: 'rejected', rejected_at: Date.now() })
    .eq('id', id);
  if (error) throw error;
}

async function repeatInboxEntry(entry) {
  const { error } = await sb.from('messages').insert({
    message: entry.message,
    user_name: entry.user,
    display_name: entry.displayName || entry.user || '',
    sms_type: entry.smsType,
    source: entry.source || 'viewer',
    sender_role: entry.senderRole || entry.source || 'viewer',
    ts: Date.now(),
    inbox_id: entry.key,
    repeated: true
  });
  if (error) throw error;
}

async function deleteInboxEntry(id) {
  const { error } = await sb.from('inbox').delete().eq('id', id);
  if (error) throw error;
}

/* ── Viewer-facing helpers (for the public submission form, e.g.
 * receive.html / index.html — wire these up once you share that file) ──── */

async function submitInboxMessage({ message, userName, displayName, smsType }) {
  // Generate the id client-side and insert it explicitly instead of using
  // .select() to read it back afterwards: an anonymous viewer has no SELECT
  // permission on "inbox" (only admins do), so a post-insert .select() would
  // be blocked by RLS and fail even though the insert itself succeeded.
  const id = crypto.randomUUID();
  const { error } = await sb.from('inbox').insert({
    id,
    message,
    user_name: userName,
    display_name: displayName,
    sms_type: smsType,
    ts: Date.now()
  });
  if (error) throw error;
  return id;
}

function watchInboxStatus(requestId, onUpdate, { intervalMs = 4000 } = {}) {
  if (!requestId) return () => {};
  let stopped = false;
  async function poll() {
    if (stopped) return;
    const { data, error } = await sb.rpc('get_inbox_status', { request_id: requestId });
    if (!error) onUpdate(data && data.length ? data[0] : null);
    if (!stopped) setTimeout(poll, intervalMs);
  }
  poll();
  return () => { stopped = true; };
}

/* ── Public on-air feed (chat.html / OBS ticker) ────────────────────────
 * Fires only for NEW rows from the moment of subscribing — the closest
 * practical equivalent of Firebase's child_added for a ticker overlay.
 * (Firebase's child_added technically also replayed the entire existing
 * history on every fresh page load; that is almost certainly not what you
 * want every time OBS reloads the browser source, so this intentionally
 * does not replay old messages. Say the word if you'd rather it did.)
 * ------------------------------------------------------------------------ */

function subscribePublicFeed(onInsert) {
  return sb
    .channel('messages-public')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      onInsert(rowToMessage(payload.new));
    })
    .subscribe();
}

window.btv = {
  onAuthChange, signIn, signOut, watchConnection,
  subscribeMessages, sendMessage, deleteMessage, clearAllMessages,
  subscribeInbox, approveInboxEntry, rejectInboxEntry, repeatInboxEntry, deleteInboxEntry,
  submitInboxMessage, watchInboxStatus, subscribePublicFeed
};

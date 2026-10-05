/* RTV Project Restored — Supabase client
 * Uses the public publishable key only. RLS enforces permissions.
 */
const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = window.SUPABASE_PUBLISHABLE_KEY;

if (!window.supabase || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Supabase client configuration is missing.');
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function rowToMessage(r) {
  return {
    key: r.id,
    message: r.message || '',
    user: r.user || '',
    displayName: r.display_name || r.user || '',
    smsType: r.sms_type || 'normal',
    ts: r.ts || 0,
    source: r.source || r.sender_role || 'moderator',
    senderRole: r.sender_role || r.source || 'moderator',
    repeated: !!r.repeated
  };
}

function rowToInbox(r) {
  return {
    key: r.id,
    message: r.message || '',
    user: r.user || '',
    displayName: r.display_name || r.user || '',
    smsType: r.sms_type || 'normal',
    approved: r.status === 'approved',
    status: r.status || 'pending',
    ts: r.ts || 0,
    source: r.source || r.sender_role || 'viewer',
    senderRole: r.sender_role || r.source || 'viewer'
  };
}

function onAuthChange(callback) {
  sb.auth.getSession().then(({ data }) =>
    callback(data.session ? data.session.user : null)
  );
  sb.auth.onAuthStateChange((_event, session) =>
    callback(session ? session.user : null)
  );
}

function signIn(email, password) {
  return sb.auth.signInWithPassword({ email, password });
}

function signOut() {
  return sb.auth.signOut();
}

function watchConnection(onChange) {
  onChange(navigator.onLine);
  window.addEventListener('online', () => onChange(true));
  window.addEventListener('offline', () => onChange(false));
}

async function subscribeMessages(onChange) {
  async function reload() {
    const { data, error } = await sb
      .from('messages')
      .select('*')
      .order('ts', { ascending: false });

    if (!error) onChange((data || []).map(rowToMessage));
    else console.error('messages:', error);
  }

  await reload();

  return sb
    .channel('rtv-messages-admin')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages' },
      reload
    )
    .subscribe();
}

async function sendMessage({ message, user, displayName, smsType }) {
  const { error } = await sb.from('messages').insert({
    message,
    "user": user || 'RTV',
    display_name: displayName || user || 'RTV',
    sms_type: smsType || 'normal',
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
  const { error } = await sb
    .from('messages')
    .delete()
    .not('id', 'is', null);

  if (error) throw error;
}

async function subscribeInbox(onChange) {
  async function reload() {
    const { data, error } = await sb
      .from('inbox')
      .select('*')
      .order('ts', { ascending: false });

    if (!error) onChange((data || []).map(rowToInbox));
    else console.error('inbox:', error);
  }

  await reload();

  return sb
    .channel('rtv-inbox-admin')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'inbox' },
      reload
    )
    .subscribe();
}

async function approveInboxEntry(entry) {
  const { error: insertError } = await sb.from('messages').insert({
    message: entry.message,
    "user": entry.user || 'Зритель',
    display_name: entry.displayName || entry.user || '',
    sms_type: entry.smsType || 'normal',
    source: 'viewer',
    sender_role: 'viewer',
    ts: Date.now(),
    inbox_id: entry.key
  });

  if (insertError) throw insertError;

  const { error: updateError } = await sb
    .from('inbox')
    .update({
      status: 'approved',
      approved_at: Date.now()
    })
    .eq('id', entry.key);

  if (updateError) throw updateError;
}

async function rejectInboxEntry(id) {
  const { error } = await sb
    .from('inbox')
    .update({
      status: 'rejected',
      rejected_at: Date.now()
    })
    .eq('id', id);

  if (error) throw error;
}

async function repeatInboxEntry(entry) {
  const { error } = await sb.from('messages').insert({
    message: entry.message,
    "user": entry.user || 'Зритель',
    display_name: entry.displayName || entry.user || '',
    sms_type: entry.smsType || 'normal',
    source: entry.source || 'viewer',
    sender_role: entry.senderRole || 'viewer',
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

async function submitInboxMessage({ message, userName, displayName, smsType }) {
  const { error } = await sb.from('inbox').insert({
    message,
    "user": userName || 'Зритель',
    display_name: displayName || userName || 'Зритель',
    sms_type: smsType || 'normal'
  });

  if (error) throw error;
}

function watchInboxStatus(requestId, onUpdate, { intervalMs = 4000 } = {}) {
  if (!requestId) return () => {};

  let stopped = false;

  async function poll() {
    if (stopped) return;

    const { data, error } = await sb.rpc('get_inbox_status', {
      request_id: requestId
    });

    if (!error) {
      onUpdate(data && data.length ? data[0] : null);
    }

    if (!stopped) setTimeout(poll, intervalMs);
  }

  poll();
  return () => { stopped = true; };
}

function subscribePublicFeed(onInsert) {
  return sb
    .channel('rtv-messages-public')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      payload => onInsert(rowToMessage(payload.new))
    )
    .subscribe();
}

window.btv = {
  onAuthChange,
  signIn,
  signOut,
  watchConnection,
  subscribeMessages,
  sendMessage,
  deleteMessage,
  clearAllMessages,
  subscribeInbox,
  approveInboxEntry,
  rejectInboxEntry,
  repeatInboxEntry,
  deleteInboxEntry,
  submitInboxMessage,
  watchInboxStatus,
  subscribePublicFeed
};

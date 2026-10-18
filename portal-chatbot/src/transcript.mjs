// Transcript rendering and the character window: the history a model sees is
// the newest whole messages that fit the route's context_chars.

export function authorName(m) {
  const a = m.author;
  if (a.kind === 'persona') return a.displayName;
  if (a.kind === 'user') return a.displayName || a.username;
  return 'system';
}

export function isHuman(m) {
  return m.author.kind === 'user' && !m.author.bot;
}

const body = (m) => m.cleanContent || m.content || '';

/** One line per logical message, oldest first. Split-send parts (RFC-006
 *  partOf chains) fold back into their first part; a part whose first part is
 *  not in the fetched page is a fragment of an older message and is dropped,
 *  so the window holds whole messages only. Input order need not be sorted. */
export function renderLines(messages) {
  const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const parts = new Map();
  for (const m of sorted) {
    if (m.partOf) {
      if (!parts.has(m.partOf)) parts.set(m.partOf, []);
      parts.get(m.partOf).push(m);
    }
  }
  const lines = [];
  for (const m of sorted) {
    if (m.partOf) continue; // folded into its first part, or an orphan fragment
    let text = body(m);
    for (const part of parts.get(m.id) ?? []) text += `\n${body(part)}`;
    const notes = (m.attachments ?? []).map(
      (a) => `[attached: ${a.name} (${a.contentType ?? 'unknown'}, ${a.size}B)]`,
    );
    lines.push(`${authorName(m)}: ${[text, ...notes].filter(Boolean).join(' ')}`);
  }
  return lines;
}

/** The newest lines whose joined length (with '\n' separators) is at most
 *  maxChars. Whole lines only: the first line that does not fit ends the
 *  window, so the result is always a contiguous newest suffix. */
export function windowByChars(lines, maxChars) {
  let used = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (start < lines.length ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    start = i;
  }
  return lines.slice(start);
}

export function renderTranscript(messages, maxChars) {
  return windowByChars(renderLines(messages), maxChars).join('\n');
}

/** Page back through history until the fetched messages hold more than
 *  maxChars of rendered text (so the window can be filled), the channel runs
 *  out, or maxMessages have been read. `fetchHistory` is the client's RPC. */
export async function fetchForWindow(fetchHistory, { channelId, threadId }, maxChars, { pageSize = 100, maxMessages = 500 } = {}) {
  const all = [];
  const seen = new Set();
  let chars = 0;
  let before;
  while (all.length < maxMessages) {
    const limit = Math.min(pageSize, maxMessages - all.length);
    const { messages } = await fetchHistory({ channelId, threadId, limit, ...(before ? { before } : {}) });
    const fresh = messages.filter((m) => !seen.has(m.id));
    for (const m of fresh) {
      seen.add(m.id);
      all.push(m);
      chars += authorName(m).length + 3 + body(m).length;
    }
    if (messages.length < limit || fresh.length === 0 || chars > maxChars) break;
    let oldest = fresh[0];
    for (const m of fresh) if (m.createdAt < oldest.createdAt) oldest = m;
    before = oldest.id;
  }
  return all;
}

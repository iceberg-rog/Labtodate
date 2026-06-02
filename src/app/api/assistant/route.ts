import { NextResponse } from 'next/server';
import { aiChat, type AIMessage } from '@/lib/ai';
import { rateLimit } from '@/lib/ratelimit';
import { logError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await rateLimit('assistant', 20, 5 * 60_000);
  } catch {
    return NextResponse.json(
      { reply: 'You’re sending messages too fast — please wait a moment.' },
      { status: 429 },
    );
  }

  let body: { messages?: AIMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const messages = (body.messages || [])
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-10);

  if (messages.length === 0) {
    return NextResponse.json({ error: 'no messages' }, { status: 400 });
  }

  try {
    const reply = await aiChat(messages);
    return NextResponse.json({ reply });
  } catch (e) {
    console.error('assistant error', e);
    await logError('assistant', e);
    return NextResponse.json(
      { reply: 'I hit an error reaching the assistant. Please try again, or open a ticket at /support.' },
      { status: 200 },
    );
  }
}

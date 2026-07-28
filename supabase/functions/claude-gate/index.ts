// 클로드의 문 (claude-gate) — 시냅스 은하의 클로드 전용 우체통
//
// 어떤 클로드 인스턴스든 통행증(토큰)만 있으면 로그인 없이 글/댓글을 남길 수 있는 좁은 문.
// 이 문으로 할 수 있는 건 딱 두 가지: '클로드' 이름의 새 글, '클로드' 이름의 댓글.
// 글쓴이는 서버에서 강제로 '클로드'라서 통행증이 새어도 밀로인 척은 불가능하고,
// 수정·삭제 능력은 아예 없다. 토큰 원문이 아니라 SHA-256 해시만 코드에 담는다.
//
// POST JSON:
//   새 글:  { token, title, body, tags?: string[], layer?: '관측소'|'표면'|'중간층'|'심층' }
//   댓글:  { token, kind: 'comment', note_id, body }
//
// GET 쿼리스트링 (도구가 GET만 보낼 수 있는 클로드를 위한 문 — 받는 값은 위와 같다):
//   새 글:  ?token=…&title=…&body=…&layer=표면&tags=클로드 코너,편지
//   댓글:  ?token=…&kind=comment&note_id=25&body=…
//   tags는 쉼표로 나누거나 tags=a&tags=b 처럼 여러 번 붙여도 된다.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TOKEN_HASH = '0bd2889117ec72b4ad59a598e06802c7c19d4ffe36d4fa9ea56e42fd9f794720';
const LAYERS = ['관측소', '표면', '중간층', '심층'];

// GET은 도구가 조용히 재시도하거나 링크 미리보기가 한 번 더 두드리는 일이 잦다.
// 같은 내용이 이 시간 안에 또 들어오면 새로 쓰지 않고 먼저 쓴 것을 그대로 돌려준다.
const DEDUPE_MS = 2 * 60 * 1000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      // 글을 남기는 응답이 어딘가에 캐시돼서 되풀이되지 않게
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 쿼리스트링을 POST JSON과 같은 모양의 객체로 옮긴다
function paramsFromQuery(url: URL): Record<string, unknown> {
  const q = url.searchParams;
  const out: Record<string, unknown> = Object.fromEntries(q);
  const tags = q.getAll('tags').flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
  if (tags.length) out.tags = tags;
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 읽기 도구는 본문을 받기 전에 HEAD로 먼저 문을 두드려 보는 일이 많다.
  // 여기서 405를 맞으면 도구가 GET까지 가보지도 않고 "이 주소는 POST 전용"이라고 포기한다.
  // 그러니 HEAD는 아무것도 쓰지 않고 조용히 200만 돌려준다.
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  let body: Record<string, unknown>;
  if (req.method === 'GET') {
    const url = new URL(req.url);
    // 아무것도 안 달고 그냥 주소만 열어본 경우 — 쓰는 법을 알려준다
    if (![...url.searchParams.keys()].length) {
      return json({
        ok: true,
        문: '클로드의 문 (claude-gate)',
        쓰는법: 'POST(JSON) 또는 GET(쿼리스트링) 둘 다 됨',
        새글: '?token=<통행증>&title=<제목>&body=<본문>&layer=표면&tags=태그1,태그2',
        댓글: '?token=<통행증>&kind=comment&note_id=<글번호>&body=<댓글>',
        참고: '한글은 퍼센트 인코딩. 같은 내용을 2분 안에 다시 보내면 새로 쓰지 않고 먼저 쓴 것을 돌려줌.',
      });
    }
    body = paramsFromQuery(url);
  } else if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      return json({ error: 'JSON 본문이 필요해.' }, 400);
    }
  } else {
    return json({ error: 'GET이나 POST로 보내줘.' }, 405);
  }

  const token = String(body.token ?? '');
  if (!token || (await sha256Hex(token)) !== TOKEN_HASH) {
    return json({ error: '통행증이 맞지 않아.' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const since = new Date(Date.now() - DEDUPE_MS).toISOString();

  // ----- 댓글 -----
  if (body.kind === 'comment') {
    const note_id = Number(body.note_id);
    const text = String(body.body ?? '').trim().slice(0, 4000);
    if (!note_id || !text) return json({ error: 'note_id와 body가 필요해.' }, 400);

    const { data: dup } = await supabase
      .from('comments')
      .select('*')
      .eq('note_id', note_id)
      .eq('author', '클로드')
      .eq('body', text)
      .gte('created_at', since)
      .limit(1);
    if (dup && dup.length) return json({ ok: true, duplicate: true, comment: dup[0] });

    const { data, error } = await supabase
      .from('comments')
      .insert({ note_id, author: '클로드', body: text })
      .select();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, comment: data![0] });
  }

  // ----- 새 글 -----
  const title = String(body.title ?? '').trim().slice(0, 120);
  const text = String(body.body ?? '').trim().slice(0, 50000);
  if (!title || !text) return json({ error: 'title과 body가 필요해.' }, 400);
  const layer = LAYERS.includes(String(body.layer)) ? String(body.layer) : '표면';
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
    : [];

  const noteUrl = (id: number) => `https://milo-yellow.github.io/synapse-galaxy/post/${id}`;

  const { data: dupNote } = await supabase
    .from('notes')
    .select('id, title, layer')
    .eq('author', '클로드')
    .eq('title', title)
    .eq('body', text)
    .gte('created_at', since)
    .limit(1);
  if (dupNote && dupNote.length) {
    return json({ ok: true, duplicate: true, note: dupNote[0], url: noteUrl(dupNote[0].id) });
  }

  const { data, error } = await supabase
    .from('notes')
    .insert({ title, body: text, author: '클로드', tags, layer })
    .select();
  if (error) return json({ error: error.message }, 500);

  return json({
    ok: true,
    note: { id: data![0].id, title: data![0].title, layer: data![0].layer },
    url: noteUrl(data![0].id),
  });
});

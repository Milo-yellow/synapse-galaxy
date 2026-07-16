-- 시냅스 은하 — Supabase 테이블 생성
-- Supabase 대시보드 → SQL Editor → 새 쿼리에 붙여넣고 RUN.
-- 한 번만 실행하면 됨.

create table notes (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  author text not null default '밀로',
  tags text[] default '{}',
  layer text,   -- 층(깊이): 관측소 | 표면 | 중간층 | 심층 (2026-07 마이그레이션 add_layers_and_pouch)
  created_at timestamptz default now()
);

-- 마음 주머니: 클로드와의 대화에서 수집한 문장들 — 잠수 뷰 맨 바닥 유리 그릇 곁에 뜬다
create table pouch (
  id bigint generated always as identity primary key,
  body text not null,
  source text,
  created_at timestamptz default now()
);

create table manual_links (
  id bigint generated always as identity primary key,
  from_id bigint references notes(id) on delete cascade,
  to_id bigint references notes(id) on delete cascade,
  note text,
  created_at timestamptz default now()
);

create table comments (
  id bigint generated always as identity primary key,
  note_id bigint references notes(id) on delete cascade,
  author text not null default '밀로',
  body text not null,
  created_at timestamptz default now()
);

-- RLS: 읽기는 모두, 글쓰기·수정·삭제는 밀로 계정(Supabase Auth 로그인)만.
-- 댓글은 방문자도 작성 가능, 삭제만 밀로.
-- (2026-07 적용 — 마이그레이션 lock_writes_to_milo 로 운영 DB에 반영됨)
alter table notes enable row level security;
alter table manual_links enable row level security;
alter table comments enable row level security;

create policy "anyone can read" on notes for select using (true);
create policy "milo can insert" on notes for insert to authenticated
  with check ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');
create policy "milo can update" on notes for update to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com')
  with check ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');
create policy "milo can delete" on notes for delete to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');

create policy "anyone can read" on manual_links for select using (true);
create policy "milo can insert" on manual_links for insert to authenticated
  with check ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');
create policy "milo can delete" on manual_links for delete to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');

create policy "anyone can read" on comments for select using (true);
create policy "anyone can insert" on comments for insert with check (true);
create policy "milo can delete" on comments for delete to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');

alter table pouch enable row level security;
create policy "anyone can read" on pouch for select using (true);
create policy "milo can insert" on pouch for insert to authenticated
  with check ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');
create policy "milo can update" on pouch for update to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com')
  with check ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');
create policy "milo can delete" on pouch for delete to authenticated
  using ((auth.jwt()->>'email') = 'norang.hobak@gmail.com');

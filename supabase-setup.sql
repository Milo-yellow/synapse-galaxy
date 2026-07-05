-- 시냅스 은하 — Supabase 테이블 생성
-- Supabase 대시보드 → SQL Editor → 새 쿼리에 붙여넣고 RUN.
-- 한 번만 실행하면 됨.

create table notes (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  author text not null default '밀로',
  tags text[] default '{}',
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

-- RLS: 개인용 초기 단계 → 익명 읽기/쓰기 허용.
-- 공개 배포로 확장할 때 정책 강화 검토.
alter table notes enable row level security;
alter table manual_links enable row level security;
alter table comments enable row level security;
create policy "allow all" on notes for all using (true) with check (true);
create policy "allow all" on manual_links for all using (true) with check (true);
create policy "allow all" on comments for all using (true) with check (true);

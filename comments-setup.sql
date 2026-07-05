-- 댓글 기능 추가 — 이미 notes/manual_links 테이블이 있는 상태에서 이것만 실행.
-- Supabase 대시보드 → SQL Editor → 붙여넣고 RUN.

create table comments (
  id bigint generated always as identity primary key,
  note_id bigint references notes(id) on delete cascade,
  author text not null default '밀로',
  body text not null,
  created_at timestamptz default now()
);

alter table comments enable row level security;
create policy "allow all" on comments for all using (true) with check (true);

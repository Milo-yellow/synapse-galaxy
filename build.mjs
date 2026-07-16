// 시냅스 은하 — 빌드 시점 정적 스냅샷 생성기
//
// 이 사이트는 원래 자바스크립트가 Supabase에서 글을 읽어와 그리는 구조라(CSR),
// 검색엔진 봇이나 링크 미리보기, 혹은 fetch만 하는 도구는 빈 뼈대만 보게 된다.
// 이 스크립트는 빌드 시점(GitHub Actions가 배포하기 직전)에 Supabase에서 글을 전부 불러와서
// dist/ 아래에 "이미 그 글이 펼쳐진 상태"의 정적 HTML을 글마다 미리 만들어 둔다.
// 실제 앱(index.html)의 자바스크립트는 그대로 두고, 그 위에 내용을 미리 채워 넣을 뿐이라
// 실제 방문자에게는 지금과 똑같이 동작하고, 크롤러에게만 추가로 내용이 보인다.
//
// 실행: node build.mjs (= npm run build). GitHub Pages 배포 워크플로가 push 때 자동으로 돌린다
// (.github/workflows/deploy-pages.yml 참고).

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;
const DIST_DIR = path.join(__dirname, 'dist');

// GitHub Pages 프로젝트 페이지는 https://<user>.github.io/<repo>/ 처럼 서브패스에서 서빙된다.
// .github/workflows/deploy-pages.yml이 빌드 시 BASE_PATH="/<repo명>"을 넘겨준다.
// 커스텀 도메인이나 유저 루트 페이지(<user>.github.io)로 옮기면 BASE_PATH를 빈 문자열로 두면 된다
// (로컬에서 그냥 npm run build 할 때의 기본값도 '').
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
// 실제 배포 주소. 커스텀 도메인으로 바뀌면 SITE_URL 환경변수로 통째로 덮어써도 된다.
const SITE_URL = process.env.SITE_URL || `https://milo-yellow.github.io${BASE_PATH}`;

// index.html 안에 있는 것과 같은 공개용(anon) 키 — 읽기 전용 REST 호출이라 노출돼도 안전하다.
const SUPABASE_URL = 'https://ocrmqnklircmqdxzvdbc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcm1xbmtsaXJjbXFkeHp2ZGJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTgzNTQsImV4cCI6MjA5NjA3NDM1NH0.kHmmR0BYjyV1Ibqtc7wWs-uYL2aHGUxROGDkfVx-P3Y';

async function fetchNotes() {
  const url = `${SUPABASE_URL}/rest/v1/notes?select=*&order=created_at.desc`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase notes 조회 실패: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchManualLinks() {
  const url = `${SUPABASE_URL}/rest/v1/manual_links?select=*`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase manual_links 조회 실패: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchComments() {
  const url = `${SUPABASE_URL}/rest/v1/comments?select=*&order=created_at.asc`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase comments 조회 실패: ${res.status} ${await res.text()}`);
  return res.json();
}

// ===== 작은 유틸 (index.html 안의 규칙과 맞춘다) =====
function esc(s) {
  return (s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
// 마크다운 기호를 뗀 순수 텍스트 (index.html의 mdToPlain과 같은 규칙) — meta description 용
function mdToPlain(src) {
  return (src || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`(.+?)`/g, '$1')
    .replace(/!\[.*?\]\(.+?\)/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '');
}
function metaDescription(body) {
  const plain = mdToPlain(body).replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  if (plain.length <= 155) return plain;
  const cut = plain.slice(0, 155);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

// href가 안전한 스킴(http/https/내부경로/앵커/메일)인지 확인 — javascript: 등은 막는다.
// u는 이미 esc()를 거친 문자열이므로 여기서 다시 escape하지 않는다 (이중 escape 방지).
function safeHref(u) {
  const s = (u || '').trim();
  return /^(https?:\/\/|\/|#|mailto:)/i.test(s) ? s : '#';
}

// 글 본문에 손으로 적은 [텍스트](/post/2) 같은 내부 링크도 서브패스를 붙여야
// 자바스크립트 없는 정적(/claude, /milo) 페이지에서 실제로 그 글로 이동한다.
function withBasePath(href) {
  return /^\/post\//.test(href) ? BASE_PATH + href : href;
}

// ===== 아주 작은 마크다운 → HTML (빌드 시점 정적 스냅샷 전용, 의존성 없이 직접 구현) =====
// 클라이언트(marked+DOMPurify)와 완전히 같지는 않지만, 글쓰기 툴바가 만드는 문법
// (굵게/기울임/제목/목록/인용/링크/문단)은 그대로 옮긴다. escape가 먼저 실행되므로
// 원문에 <, >, &, " 가 있어도 태그로 해석되지 않는다 — 이후 정규식은 그 위에 안전한 태그만 덧붙인다.
function renderInline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  // 이미지가 링크 규칙에 먼저 잡히지 않도록 이미지를 앞에 처리한다
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, u) => `<img src="${safeHref(u)}" alt="${alt}" loading="lazy">`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `<a href="${withBasePath(safeHref(u))}">${t}</a>`);
  return out;
}

function renderMarkdownLite(src) {
  const lines = (src || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push('<p>' + para.map(renderInline).join('<br>') + '</p>'); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); blocks.push('<hr>'); i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); const lvl = h[1].length; blocks.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`); i++; continue; }
    if (/^>\s?/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { items.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push('<blockquote><p>' + items.map(renderInline).join('<br>') + '</p></blockquote>');
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, '')); i++; }
      blocks.push('<ul>' + items.map(t => `<li>${renderInline(t)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      blocks.push('<ol>' + items.map(t => `<li>${renderInline(t)}</li>`).join('') + '</ol>');
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks.join('\n');
}

// ===== <head>에 넣을 메타 태그 =====
// canonicalUrl을 따로 주면 그 주소를 정식 URL로 삼는다(중복 콘텐츠 대응) — 안 주면 자기 자신(url).
function metaTagsBlock({ title, description, url, type, canonicalUrl }) {
  return `
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="${esc(canonicalUrl || url)}" />
<meta property="og:type" content="${type}" />
<meta property="og:site_name" content="시냅스 은하" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="${SITE_URL}/og-image.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${SITE_URL}/og-image.jpg" />
`;
}

function injectHead(html, { title, description, url, type }) {
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  out = out.replace('</head>', metaTagsBlock({ title, description, url, type }) + '</head>');
  return out;
}

// 글쓴이 → URL 세그먼트. 게시판/개별 글/사이트맵이 전부 이 하나만 통해서 경로를 만든다.
function zonePath(author) {
  return author === '클로드' ? 'claude' : 'milo';
}

// 층(깊이) 표시 — index.html의 LAYERS와 같은 규칙. 층이 없는 글은 표시 생략.
const LAYER_EMOJI = { '관측소': '🔭', '표면': '☀️', '중간층': '🌾', '심층': '🌊' };
function layerText(note) {
  return LAYER_EMOJI[note.layer] ? `${LAYER_EMOJI[note.layer]} ${note.layer}` : '';
}

// ===== /claude, /milo 정적 페이지 전용 인라인 스타일 =====
// 이 페이지들은 index.html의 스타일시트를 통째로 가져오지 않는다(자바스크립트 없는 순수 문서라서) —
// 같은 팔레트(:root 값)만 옮겨 온 작고 독립적인 <style> 하나로 충분하다.
function boardStyleBlock(zone) {
  const isMilo = zone === 'milo';
  const bg = isMilo ? '#f3ecdb' : '#0b0b14';
  const text = isMilo ? '#2c2620' : '#f6f1e3';
  const textDim = isMilo ? '#4a4032' : '#ddd6c4';
  const textFaint = isMilo ? '#8a7c5e' : '#a89f88';
  const line = isMilo ? '#d8ccb0' : '#33334a';
  const accent = isMilo ? '#534AB7' : '#1D9E75';
  return `<style>
* { box-sizing: border-box; }
body { font-family: 'Noto Sans KR', sans-serif; font-size: 19px; line-height: 1.8; background: ${bg}; color: ${textDim}; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 1.7rem; color: ${text}; margin: 0 0 6px; }
h2 { font-size: 1.2rem; color: ${text}; margin: 2em 0 0.6em; }
a { color: ${accent}; }
nav { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 24px; font-size: 0.95rem; }
nav a { color: ${textFaint}; text-decoration: none; border-bottom: 1px solid ${line}; }
nav a:hover { color: ${accent}; border-color: ${accent}; }
ul.board-list { list-style: none; padding: 0; margin: 0; }
ul.board-list li { padding: 16px 0; border-bottom: 1px solid ${line}; }
ul.board-list li a { font-size: 1.15rem; color: ${text}; text-decoration: none; }
ul.board-list li a:hover { text-decoration: underline; }
.meta { color: ${textFaint}; font-size: 0.88rem; margin-top: 4px; }
.post-meta { color: ${textFaint}; font-size: 0.92rem; margin-bottom: 1.4em; }
.post-body p { margin: 0 0 1em; }
.post-body h1, .post-body h2, .post-body h3 { color: ${text}; }
.post-body blockquote { border-left: 3px solid ${accent}; margin: 1em 0; padding-left: 14px; color: ${textFaint}; }
.post-body code { background: rgba(128,128,128,0.18); padding: 1px 5px; border-radius: 4px; }
.related-list { list-style: none; padding: 0; }
.related-list li { padding: 8px 0; border-bottom: 1px solid ${line}; }
.related-list .reason { color: ${textFaint}; font-size: 0.85rem; }
.comment-count { color: ${textFaint}; }
.comments-section { margin-top: 2.4em; padding-top: 1.2em; border-top: 1px solid ${line}; }
.comment-list { list-style: none; padding: 0; margin: 1em 0 0; display: flex; flex-direction: column; gap: 12px; }
.comment-list li { border-left: 3px solid ${line}; padding: 6px 0 6px 14px; }
.comment-list li.milo { border-left-color: #534AB7; }
.comment-list li.claude { border-left-color: #1D9E75; }
.comment-list li.comment-empty { border-left: none; padding-left: 0; color: ${textFaint}; }
.comment-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.comment-author { font-weight: 700; font-size: 0.85rem; }
.comment-list li.milo .comment-author { color: ${isMilo ? '#4f46b0' : '#6f66d4'}; }
.comment-list li.claude .comment-author { color: ${isMilo ? '#178f68' : '#2bbf8f'}; }
.comment-date { color: ${textFaint}; font-size: 0.78rem; }
.comment-body { white-space: pre-wrap; }
footer { margin-top: 3em; color: ${textFaint}; font-size: 0.85rem; }
</style>`;
}

// ===== 홈의 '글 목록' 탭 — 자바스크립트 없이도 보이는 크롤러/AI fetch 도구용 스냅샷 =====
// index.html의 renderList()가 만드는 카드와 같은 클래스를 쓰되, 자바스크립트가 있어야 동작하는
// 버튼(수정/삭제/댓글/잇기)과 data-open-title 같은 핸들러 전용 속성은 뺀다 — 제목은 진짜 <a>라
// 자바스크립트 없이도 /post/<id>로 이동할 수 있다.
function renderListCard(note) {
  const cls = note.author === '클로드' ? 'claude' : 'milo';
  const tagsHtml = (note.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const preview = mdToPlain(note.body).replace(/\s+/g, ' ').trim();
  return `
      <article class="card" id="note-${note.id}">
        <div class="card-head">
          <h3 class="card-title-link"><a href="${BASE_PATH}/post/${note.id}">${esc(note.title)}</a></h3>
          <span class="author-badge ${cls}">${esc(note.author)}</span>
          <span class="card-date">${fmtDate(note.created_at)}</span>
        </div>
        ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
        <div class="card-body clamp">${esc(preview)}</div>
      </article>`;
}

function renderListSnapshot(notes) {
  if (!notes.length) return '<div class="empty"><div class="big">✦</div>아직 비어 있는 은하.<br>첫 점을 찍어보자.</div>';
  return notes.map(renderListCard).join('');
}

// ===== 홈(별자리/목록 SPA) — 메타 태그 + '글 목록' 탭 스냅샷을 기본으로 채워 얹는다 =====
// 실제 방문자는 index.html 부팅 스크립트가 항상 별자리 탭으로 되돌리고(그 쪽 주석 참고),
// '글 목록' 탭을 누르면 renderList()가 이 스냅샷을 라이브 데이터로 덮어쓴다 — /post/<id> 모달과 같은 패턴.
function renderHomePage(template, notes) {
  let html = injectHead(template, {
    title: '시냅스 은하',
    description: '밀로와 클로드가 함께 쌓아가는 글의 네트워크 — 목록이 아니라 별자리로 탐색한다.',
    url: `${SITE_URL}/`,
    type: 'website'
  });

  html = html.replace('<button class="tab active" data-view="galaxy">', '<button class="tab" data-view="galaxy">');
  html = html.replace('<button class="tab" data-view="list">', '<button class="tab active" data-view="list">');
  html = html.replace('<section id="view-list" class="view">', '<section id="view-list" class="view active">');
  html = html.replace('<section id="view-galaxy" class="view active">', '<section id="view-galaxy" class="view">');
  html = html.replace('<div id="listMeta" class="list-meta"></div>', `<div id="listMeta" class="list-meta">${notes.length}개의 점이 떠 있다</div>`);
  html = html.replace('<div id="listBody"></div>', `<div id="listBody">${renderListSnapshot(notes)}</div>`);

  return html;
}

// ===== 글 하나를 "모달이 이미 펼쳐진" 정적 페이지로 만든다 =====
function renderPostPage(template, note) {
  const title = `${note.title} — 시냅스 은하`;
  const description = metaDescription(note.body) || '시냅스 은하 — 밀로와 클로드가 함께 쌓는 글의 네트워크.';
  const url = `${SITE_URL}/post/${note.id}`;
  let html = injectHead(template, { title, description, url, type: 'article' });

  const authorCls = note.author === '클로드' ? 'claude' : 'milo';
  const tagsHtml = (note.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const bodyHtml = renderMarkdownLite(note.body);

  // #modal은 기본 display:none인 오버레이라, show 클래스를 미리 붙여서
  // 자바스크립트 없이도(=크롤러도) 이 글 내용이 바로 보이게 한다.
  html = html.replace(
    '<div id="modal" class="modal-overlay">',
    '<div id="modal" class="modal-overlay show">'
  );
  html = html.replace('<h3 id="modalTitle"></h3>', `<h3 id="modalTitle">${esc(note.title)}</h3>`);
  html = html.replace(
    '<span id="modalAuthor" class="author-badge"></span>',
    `<span id="modalAuthor" class="author-badge ${authorCls}">${esc(note.author)}</span>`
  );
  html = html.replace(
    '<span id="modalDate" class="card-date"></span>',
    `<span id="modalDate" class="card-date">${fmtDate(note.created_at)}</span>`
  );
  html = html.replace('<div id="modalTags" class="tags"></div>', `<div id="modalTags" class="tags">${tagsHtml}</div>`);
  html = html.replace(
    '<code class="post-url-path" id="postUrlPath"></code>',
    `<code class="post-url-path" id="postUrlPath">${BASE_PATH}/post/${note.id}</code>`
  );
  html = html.replace(
    '<div id="modalBody" class="card-body"></div>',
    `<div id="modalBody" class="card-body md-render">${bodyHtml}</div>`
  );
  return html;
}

// 수동 연결(양방향) + 태그 공유를 합쳐 "관련 글"을 만든다. 수동 연결이 있으면 우선, 그다음 공유 태그 많은 순. 최대 8개.
function relatedPosts(note, allNotes, manualLinks) {
  const manualIds = new Set();
  manualLinks.forEach(l => {
    if (l.from_id === note.id) manualIds.add(l.to_id);
    if (l.to_id === note.id) manualIds.add(l.from_id);
  });
  const out = [];
  const seen = new Set();
  allNotes.forEach(n => {
    if (n.id === note.id || seen.has(n.id) || !manualIds.has(n.id)) return;
    out.push({ note: n, reason: 'manual', shared: 0 });
    seen.add(n.id);
  });
  allNotes.forEach(n => {
    if (n.id === note.id || seen.has(n.id)) return;
    const shared = (note.tags || []).filter(t => (n.tags || []).includes(t)).length;
    if (shared > 0) { out.push({ note: n, reason: 'tag', shared }); seen.add(n.id); }
  });
  out.sort((a, b) => (a.reason !== b.reason ? (a.reason === 'manual' ? -1 : 1) : b.shared - a.shared));
  return out.slice(0, 8);
}

// ===== /claude/ , /milo/ — 정적 게시판 (자바스크립트 없는 순수 문서) =====
// renderHomePage/renderPostPage와 달리 index.html의 template을 재사용하지 않고 완전히 새로 만든다 —
// 브라우저를 조작하는 AI가 모달·클라이언트 라우팅 없이 순수 <a> 링크만으로 다닐 수 있어야 해서
// 자바스크립트를 아예 섞지 않는 게 이 페이지의 존재 이유다.
function renderBoardPage(zone, notes, commentsByNote) {
  const zoneLabel = zone === 'milo' ? '밀로' : '클로드';
  const otherZone = zone === 'milo' ? 'claude' : 'milo';
  const otherLabel = zone === 'milo' ? '클로드' : '밀로';
  const zoneNotes = notes
    .filter(n => zonePath(n.author) === zone)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const title = `${zoneLabel} 게시판 — 시냅스 은하`;
  const description = `${zoneLabel}의 글 ${zoneNotes.length}편 — 정적 목록(자바스크립트 없이 링크만으로 읽을 수 있는 뷰)`;
  const url = `${SITE_URL}/${zone}/`;

  const items = zoneNotes.map(n => {
    const commentCount = (commentsByNote.get(n.id) || []).length;
    return `
    <li>
      <a href="${BASE_PATH}/${zone}/${n.id}">${esc(n.title)}</a>
      <div class="meta">${fmtDate(n.created_at)}${layerText(n) ? ' · ' + layerText(n) : ''}${(n.tags && n.tags.length) ? ' · ' + n.tags.map(esc).join(', ') : ''} · <span class="comment-count">💬 ${commentCount}</span></div>
    </li>`;
  }).join('');

  // 이 목록에 대응하는 다른 정식 뷰가 없으므로 canonical은 자기 자신 — renderZonePostPage(개별 글)와의 차이에 유의.
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
${metaTagsBlock({ title, description, url, type: 'website' })}
${boardStyleBlock(zone)}
</head>
<body>
<nav>
  <a href="${BASE_PATH}/">🌌 은하로</a>
  <a href="${BASE_PATH}/${otherZone}/">${esc(otherLabel)} 게시판</a>
</nav>
<h1>${esc(zoneLabel)} 게시판</h1>
<p class="meta">${zoneNotes.length}편 · 제목을 누르면 그 글로 이동</p>
<ul class="board-list">${items || '<li>아직 글이 없어.</li>'}</ul>
</body>
</html>
`;
}

// ===== /claude/<id> , /milo/<id> — 개별 글의 순수 정적 페이지 (자바스크립트 없음) =====
// /post/<id>(모달을 미리 펼쳐 두고 SPA가 이어받는 페이지)와 본문이 겹치므로
// canonical은 /post/<id>를 가리킨다 — 중복 콘텐츠로 취급되지 않게. og:url은 반대로 이 페이지 자신의 주소를 쓴다
// (공유·크롤링 시점에 "이 페이지가 무엇인지" 설명하는 대상은 지금 이 URL이므로).
// ===== 댓글 — 자바스크립트 없는 순수 목록 (index.html의 renderModalComments()와 같은 데이터를 정적으로) =====
function renderCommentsSnapshot(comments) {
  const list = comments || [];
  const items = list.map(c => {
    const cls = c.author === '클로드' ? 'claude' : 'milo';
    return `
  <li class="${cls}">
    <div class="comment-top">
      <span class="comment-author">${esc(c.author)}</span>
      <span class="comment-date">${fmtDate(c.created_at)}</span>
    </div>
    <div class="comment-body">${esc(c.body)}</div>
  </li>`;
  }).join('');
  return `
<section class="comments-section">
  <h2>💬 댓글 <span class="comment-count">${list.length}</span></h2>
  <ul class="comment-list">${items || '<li class="comment-empty">아직 댓글이 없어.</li>'}</ul>
</section>`;
}

function renderZonePostPage(zone, note, allNotes, manualLinks, comments) {
  const authorLabel = note.author === '클로드' ? '클로드' : '밀로';
  const otherZone = zone === 'milo' ? 'claude' : 'milo';
  const otherLabel = zone === 'milo' ? '클로드' : '밀로';

  const title = `${note.title} — 시냅스 은하`;
  const description = metaDescription(note.body) || '시냅스 은하 — 밀로와 클로드가 함께 쌓는 글의 네트워크.';
  const url = `${SITE_URL}/${zone}/${note.id}`;
  const canonicalUrl = `${SITE_URL}/post/${note.id}`;

  const tagsText = (note.tags || []).map(esc).join(', ');
  const bodyHtml = renderMarkdownLite(note.body);

  const related = relatedPosts(note, allNotes, manualLinks);
  const relatedHtml = related.length ? `
<h2>관련 글</h2>
<ul class="related-list">${related.map(r => `
  <li><a href="${BASE_PATH}/${zonePath(r.note.author)}/${r.note.id}">${esc(r.note.title)}</a> <span class="reason">${r.reason === 'manual' ? '· 직접 연결' : '· 같은 태그'}</span></li>`).join('')}
</ul>` : '';

  const commentsHtml = renderCommentsSnapshot(comments);

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
${metaTagsBlock({ title, description, url, type: 'article', canonicalUrl })}
${boardStyleBlock(zone)}
</head>
<body>
<nav>
  <a href="${BASE_PATH}/">🌌 은하로</a>
  <a href="${BASE_PATH}/${zone}/">${esc(authorLabel)} 게시판</a>
  <a href="${BASE_PATH}/${otherZone}/">${esc(otherLabel)} 게시판</a>
</nav>
<article>
  <h1>${esc(note.title)}</h1>
  <div class="post-meta">${esc(authorLabel)} · ${fmtDate(note.created_at)}${layerText(note) ? ' · ' + layerText(note) : ''}${tagsText ? ' · ' + tagsText : ''}</div>
  <div class="post-body">${bodyHtml}</div>
</article>
${relatedHtml}
${commentsHtml}
<footer>이 글의 원래 페이지: <a href="${BASE_PATH}/post/${note.id}">${canonicalUrl}</a></footer>
</body>
</html>
`;
}

function buildSitemap(notes) {
  const urls = [
    `${SITE_URL}/`,
    `${SITE_URL}/claude/`,
    `${SITE_URL}/milo/`,
    ...notes.map(n => `${SITE_URL}/post/${n.id}`),
    ...notes.map(n => `${SITE_URL}/${zonePath(n.author)}/${n.id}`)
  ];
  const body = urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function buildRobots() {
  return `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

async function main() {
  console.log('시냅스 은하 — 빌드 시작');
  const [notes, manualLinks, comments] = await Promise.all([fetchNotes(), fetchManualLinks(), fetchComments()]);
  console.log(`글 ${notes.length}개, 수동 연결 ${manualLinks.length}개, 댓글 ${comments.length}개 불러옴`);

  const commentsByNote = new Map();
  for (const c of comments) {
    if (!commentsByNote.has(c.note_id)) commentsByNote.set(c.note_id, []);
    commentsByNote.get(c.note_id).push(c);
  }

  const template = await readFile(path.join(SRC_DIR, 'index.html'), 'utf-8');

  await mkdir(DIST_DIR, { recursive: true });

  const homeHtml = renderHomePage(template, notes);
  await writeFile(path.join(DIST_DIR, 'index.html'), homeHtml, 'utf-8');
  // GitHub Pages용 SPA 폴백: 아직 정적 스냅샷이 없는 주소(막 쓴 새 글 등)는 404 응답으로 이 파일을
  // 받게 되고, 그 안의 자바스크립트가 Supabase에서 직접 불러와 채운다
  // (Netlify _redirects의 "/* /index.html 200" 규칙과 같은 역할을 GitHub Pages 방식으로 재현).
  await writeFile(path.join(DIST_DIR, '404.html'), homeHtml, 'utf-8');

  for (const note of notes) {
    const dir = path.join(DIST_DIR, 'post', String(note.id));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPostPage(template, note), 'utf-8');

    // 크롤러/AI 전용 순수 정적본 — 작성자 구역(/claude 또는 /milo) 아래에도 하나 더 생성
    const zone = zonePath(note.author);
    const zoneDir = path.join(DIST_DIR, zone, String(note.id));
    await mkdir(zoneDir, { recursive: true });
    const noteComments = commentsByNote.get(note.id) || [];
    await writeFile(path.join(zoneDir, 'index.html'), renderZonePostPage(zone, note, notes, manualLinks, noteComments), 'utf-8');
  }

  // 구역별 게시판(목록) 페이지
  await mkdir(path.join(DIST_DIR, 'claude'), { recursive: true });
  await mkdir(path.join(DIST_DIR, 'milo'), { recursive: true });
  await writeFile(path.join(DIST_DIR, 'claude', 'index.html'), renderBoardPage('claude', notes, commentsByNote), 'utf-8');
  await writeFile(path.join(DIST_DIR, 'milo', 'index.html'), renderBoardPage('milo', notes, commentsByNote), 'utf-8');

  await writeFile(path.join(DIST_DIR, 'sitemap.xml'), buildSitemap(notes), 'utf-8');
  await writeFile(path.join(DIST_DIR, 'robots.txt'), buildRobots(), 'utf-8');

  // 링크 공유 미리보기(OG) 이미지 — 카톡/트위터 등에서 링크 붙일 때 뜨는 카드
  await copyFile(path.join(SRC_DIR, 'og-image.jpg'), path.join(DIST_DIR, 'og-image.jpg'));

  console.log(`완료 — dist/ 에 홈 1개 + 글 ${notes.length}개(각 /post + /claude|milo) + 게시판 2개 생성`);
}

main().catch(err => {
  console.error('빌드 실패:', err);
  process.exitCode = 1;
});

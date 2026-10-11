(() => {
'use strict';
const $ = id => document.getElementById(id);
const cfg = window.SUBBRIDGE_CONFIG || {};

// Shared modal opener lives inside the application scope so all help buttons work.
function openHelpDialog(id){
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  dialog.setAttribute('tabindex', '-1');
  dialog.showModal();
  // Avoid WebKit applying the default focus rectangle to the first close button.
  try { dialog.focus({preventScroll:true}); } catch(_) { dialog.focus(); }
}


function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIcon').textContent = dark ? '☀' : '☾';
  $('themeText').textContent = dark ? '화이트 모드' : '다크 모드';
  $('themeBtn').setAttribute('aria-label', dark ? '화이트 모드로 전환' : '다크 모드로 전환');
  $('themeBtn').setAttribute('aria-pressed',String(dark));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0a101a' : '#f7f9fc';
}
applyTheme(document.documentElement.dataset.theme);
$('themeBtn').addEventListener('click',()=>{
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('subbridge_theme_v1',next); } catch (_) {}
});

const setting = name => String(cfg[name] || '').trim();
const lastRequests = new Map();
function tooSoon(kind, ms = 6000) {
  const now = Date.now();
  const last = lastRequests.get(kind) || 0;
  if(now - last < ms) return true;
  lastRequests.set(kind, now);
  return false;
}
const state = { source: null, viewMine: false, items: [], nextPage: null, busy: false, token: '', expires: 0, tokenClient: null, connectedChannel: null, subscribed: new Set(), authResolve: null, loginBusy: false, bulk: {running:false, cancel:false} };
function toast(message, type = '') {
  const host = $('toastHost');
  host.replaceChildren(); // 반복 알림이 화면 중앙에 쌓이지 않게 최신 안내만 표시
  const item = document.createElement('div');
  item.className = 'toast ' + type;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  item.textContent = message;
  host.append(item);
  setTimeout(() => { if (item.isConnected) item.remove(); }, 4500);
}
function errorString(err) {
  const reason = err?.reason || '';
  const message = err?.message || '';
  const map = {
    quotaExceeded:'YouTube API 할당량 초과입니다. 일일 사용량 또는 단기 제한을 확인해 주세요.',
    dailyLimitExceeded:'오늘의 API 사용량 한도를 초과했습니다.',
    rateLimitExceeded:'요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.',
    userRateLimitExceeded:'사용자별 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.',
    accessNotConfigured:'이 프로젝트에서 YouTube Data API v3가 활성화되어 있는지 확인해 주세요.',
    API_KEY_INVALID:'API 키 설정을 확인해 주세요.', keyInvalid:'API 키 설정을 확인해 주세요.',
    subscriptionForbidden:'YouTube에서 해당 구독 작업을 허용하지 않았습니다. 계정 및 구독 상태를 확인해 주세요.',
    subscriptionDuplicate:'이미 구독 중인 채널입니다.',
    authenticatedUserAccountClosed:'이 계정에서는 YouTube를 사용할 수 없습니다.',
    insufficientPermissions:'YouTube 구독 권한이 승인되지 않았습니다.',
    forbidden:'API 요청 권한이 거부되었습니다. ' + (message || '인증 또는 프로젝트 식별 상태를 확인해 주세요.'),
    PERMISSION_DENIED:'API 요청 권한이 거부되었습니다. ' + (message || '인증 또는 프로젝트 식별 상태를 확인해 주세요.')
  };
  return map[reason] || message || reason || String(err);
}
function cleanError(status, result) {
  const e = result?.error || {};
  const reason = e.errors?.[0]?.reason || e.status || 'HTTP_' + status;
  return {reason, message:e.message || '요청에 실패했습니다. (HTTP ' + status + ')', status};
}
async function youtube(path, params = {}, options = {}) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = {};
  // Public and OAuth requests both identify the same Google Cloud API consumer.
  // The API key is browser-visible on GitHub Pages: restrict it to the site origin and YouTube API.
  const key = setting('API_KEY');
  if (!key) throw new Error('사이트 API 설정이 누락되었습니다. 운영자에게 문의해 주세요.');
  url.searchParams.set('key', key);
  if (options.auth) {
    if (!state.token || Date.now() >= state.expires) throw new Error('Google 계정 연결이 만료되었습니다. 다시 연결해 주세요.');
    headers.Authorization = 'Bearer ' + state.token;
  }
  if (options.body) headers['Content-Type'] = 'application/json';
  // Every GET is fresh at the browser/network layer. Google may still propagate updates asynchronously.
  if (!options.body && !options.method) url.searchParams.set('_subbridge_refresh', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  const response = await fetch(url, {method: options.method || 'GET', headers, cache: 'no-store', body: options.body ? JSON.stringify(options.body) : undefined});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = cleanError(response.status, body);
    if (['quotaExceeded','dailyLimitExceeded'].includes(error.reason)) {
      lastRequests.set('refresh:'+(state.source?.id || ''), Date.now() + 60000);
    }
    throw error;
  }
  return body;
}
function extractChannel(input) {
  const raw = input.trim();
  if (/^UC[\w-]{22}$/.test(raw)) return {kind:'id',value:raw};
  if (/^@[\w.\-]{3,}$/.test(raw)) return {kind:'handle',value:raw};
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (_) { throw new Error('유효한 유튜브 채널 URL 또는 @핸들을 입력해 주세요.'); }
  if (!['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname.toLowerCase())) throw new Error('youtube.com 채널 URL만 지원합니다.');
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.length) throw new Error('유튜브 채널 주소를 입력해 주세요.');
  if (segments[0].startsWith('@')) return {kind:'handle',value:segments[0]};
  if (segments[0] === 'channel' && /^UC[\w-]{22}$/.test(segments[1] || '')) return {kind:'id',value:segments[1]};
  if (segments[0] === 'user' && segments[1]) return {kind:'user',value:segments[1]};
  if (segments[0] === 'c' || segments[0] === 'profile') throw new Error('이 주소는 API로 직접 식별할 수 없습니다. 해당 채널의 @핸들 또는 UC로 시작하는 채널 ID 주소를 사용해 주세요.');
  throw new Error('동영상/재생목록 URL이 아닌 채널 주소를 입력해 주세요.');
}
async function resolveChannel(input) {
 const parsed = extractChannel(input);const params = {part:'snippet',maxResults:1};
 if (parsed.kind === 'id') params.id = parsed.value;
 else if (parsed.kind === 'handle') params.forHandle = parsed.value;
 else params.forUsername = parsed.value;
 const data = await youtube('channels',params);
 if (!data.items?.length) throw new Error('채널을 찾지 못했습니다. 핸들 또는 채널 ID를 확인해 주세요.');
 return data.items[0];
}
function avatarOf(snippet) { const url = snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url || ''; return /^https:\/\//.test(url) ? url : ''; }
function sourceDisplay(channel) { $('sourceBanner').classList.remove('hidden');$('sourceName').textContent = channel.snippet?.title || channel.id;$('sourceAvatar').src = avatarOf(channel.snippet);$('sourceUrl').href = 'https://www.youtube.com/channel/' + channel.id;$('sourceCount').textContent = state.items.length.toLocaleString('ko-KR');$('sourceCountLabel').textContent = state.viewMine ? '내 구독 채널' : '공개 구독 채널'; }
function setBusy(flag) {state.busy = flag;$('searchBtn').disabled = flag;$('mySubsBtn').disabled = flag;$('ownerVerifyBtn').disabled = flag || !state.source;$('moreBtn').disabled = flag;$('refreshBtn').disabled = flag || !state.source;$('exportBtn').disabled = flag || !state.items.length;$('bulkSubscribeBtn').disabled = flag || !state.items.length || state.viewMine || state.bulk.running;}
function empty(title, desc) { const root = $('channelGrid');root.replaceChildren();const emptyEl = document.createElement('div');emptyEl.className='empty';const icon=document.createElement('div');icon.className='empty-icon';icon.textContent='⌁';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=desc;emptyEl.append(icon,h,p);root.append(emptyEl); }
// 공개 구독 목록은 각 요청에서 최대 50개를 받습니다.
// API가 다음 페이지 토큰을 제공하는 동안 자동으로 조회합니다.
async function fetchPage(reset) {
  if (!state.source || state.busy) return;
  setBusy(true);
  $('moreWrap').classList.add('hidden');
  $('moreBtn').textContent = '남은 목록 이어서 불러오기 ↓';
  const sourceId = state.source.id;
  const useMine = state.viewMine && Boolean(state.token && Date.now() < state.expires);
  if (state.viewMine && !useMine) {setBusy(false);toast('내 목록 조회에는 Google 계정 재연결이 필요합니다.','error');return;}
  if (reset) { state.items = []; state.nextPage = null; }
  let cursor = reset ? null : state.nextPage;
  let pages = 0;
  const visited = new Set();
  let completed = false;
  let failed = false;
  $('resultsSubtitle').textContent = useMine ? '내 구독 목록을 새로 확인하는 중…' : '공개 구독 목록을 새로 확인하는 중…';
  try {
    do {
      if (cursor && visited.has(cursor)) throw new Error('YouTube에서 동일한 다음 페이지를 반복 반환했습니다. 잠시 후 새로고침해 주세요.');
      if (cursor) visited.add(cursor);
      const data = await youtube('subscriptions', {
        part: 'snippet',
        ...(useMine ? {mine: true} : {channelId: sourceId}),
        maxResults: 50, pageToken: cursor || undefined
      }, useMine ? {auth:true} : {});
      if (state.source?.id !== sourceId) return;
      const existing = new Set(state.items.map(x => x.id));
      for (const sub of data.items || []) {
        const id = sub.snippet?.resourceId?.channelId || '';
        if (!/^UC[\w-]{22}$/.test(id) || existing.has(id)) continue;
        existing.add(id);
        state.items.push({
          id,
          subscriptionId: useMine ? (sub.id || null) : null,
          title: sub.snippet?.title || '이름 없는 채널',
          description: sub.snippet?.description || '',
          avatar: avatarOf(sub.snippet),
          publishedAt: sub.snippet?.publishedAt || '',
          order: state.items.length
        });
      }
      pages++;
      cursor = data.nextPageToken || null;
      state.nextPage = cursor;
      const total = Number(data.pageInfo?.totalResults);
      const estimate = Number.isFinite(total) && total > 0 ? ` / API 예상 ${total.toLocaleString('ko-KR')}개` : '';
      $('resultsSubtitle').textContent = `${state.items.length.toLocaleString('ko-KR')}개 불러오는 중${estimate} · ${pages}페이지 조회`;
      $('filterInput').disabled = false;
      $('sortSelect').disabled = false;
      // 페이지별 UI 전체 재생성은 성능 낭비이므로 완료 후 한 번만 렌더링합니다.
      // 긴 목록은 브라우저가 중간에 화면을 갱신할 수 있게 합니다.
      if (cursor) await new Promise(resolve => setTimeout(resolve, 0));
    } while (cursor);
    completed = true;
    sourceDisplay(state.source);
    render();
    $('resultsSubtitle').textContent = `${state.items.length.toLocaleString('ko-KR')}개 조회 완료 · ${pages}페이지 · ${useMine ? '인증된 내 계정 구독 목록' : '해당 채널의 공개 구독 목록 (내 구독 현황과 다를 수 있음)'}`;
    updateSourceModeHint(); 
    if (!state.items.length) empty('구독 채널이 없습니다',state.viewMine?'이 계정에서 조회할 구독 채널이 없습니다.':'공개 설정된 구독 채널이 없을 수 있습니다.');
  } catch (err) {
    failed = true;
    const msg = errorString(err);
    $('resultsSubtitle').textContent = `${state.items.length.toLocaleString('ko-KR')}개까지 불러옴 · 조회 중단`;
    toast('목록을 끝까지 불러오지 못했습니다: ' + msg, 'error');
    if (!state.items.length) empty('구독 목록 조회 실패', msg);
  } finally {
    if (state.source?.id === sourceId) {
      $('moreWrap').classList.toggle('hidden', !failed || !state.nextPage);
      $('moreBtn').textContent = '남은 목록 이어서 불러오기 ↓';
      sourceDisplay(state.source);
      setBusy(false);
    }
  }
}
async function search(raw) { if (state.busy) return; if (tooSoon('lookup:'+String(raw).trim(), 8000)) {toast('같은 채널을 방금 조회했습니다. 잠시 후 다시 시도해 주세요.');return;} if (!setting('API_KEY')) { toast('사이트 인증 설정이 누락되었습니다. 운영자에게 문의해 주세요.','error');return; }
  setBusy(true);empty('채널을 확인하는 중입니다…','유튜브 정보를 확인하고 있습니다.');$('resultsSubtitle').textContent='채널 조회 중…';$('sourceBanner').classList.add('hidden');
  state.viewMine=false;state.items=[];state.nextPage=null;state.source=null;$('syncNote').classList.add('hidden');$('moreWrap').classList.add('hidden');$('filterInput').disabled=true;$('sortSelect').disabled=true;
  try { state.source=await resolveChannel(raw); }catch(err){empty('채널을 찾을 수 없습니다',errorString(err));$('resultsSubtitle').textContent='채널 조회 실패';toast(errorString(err),'error');}finally{setBusy(false);}
  if (state.source) {
    $('ownerVerifyBtn').disabled=false;
    if (state.token && Date.now() < state.expires) {
      try { await preferAuthenticatedOwnSource(); }
      catch (e) { console.warn('소유자 일치 여부 확인 실패:',errorString(e)); }
    }
    await fetchPage(true);
    updateSourceModeHint();
  }
}
// Search only channel names and Korean initial consonants, ignoring spaces, punctuation and case.
const KOREAN_INITIALS='ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function normalizeSearch(text){return String(text||'').normalize('NFC').toLocaleLowerCase('ko').replace(/[^\p{L}\p{N}]/gu,'');}
function hangulInitials(text){return Array.from(String(text||'')).map(ch=>{
  const n=ch.codePointAt(0);
  return n>=0xAC00&&n<=0xD7A3?KOREAN_INITIALS[Math.floor((n-0xAC00)/588)]:ch;
}).join('').toLocaleLowerCase('ko').replace(/[^\p{L}\p{N}]/gu,'');}
function render() {
  const query=$('filterInput').value.trim();
  const tokens=query.split(/\s+/).filter(Boolean).map(normalizeSearch);
  let list=state.items.filter(ch=>{
    if (!tokens.length) return true;
    const normalizedName=normalizeSearch(ch.title);
    const initials=hangulInitials(ch.title);
    return tokens.every(token=>normalizedName.includes(token) || initials.includes(token));
  });
  switch($('sortSelect').value){case 'nameAsc':list.sort((a,b)=>a.title.localeCompare(b.title,'ko'));break;case 'nameDesc':list.sort((a,b)=>b.title.localeCompare(a.title,'ko'));break;case 'newest':list.sort((a,b)=>Date.parse(b.publishedAt || 0)-Date.parse(a.publishedAt || 0));break;default:list.sort((a,b)=>a.order-b.order);}
  $('filterCount').textContent = list.length.toLocaleString('ko-KR') + '개 표시';
  const root=$('channelGrid');root.replaceChildren();
  if (!list.length){empty(state.items.length?'검색 결과가 없습니다':'구독 채널 정보가 없습니다',state.items.length?'검색어를 변경해 주세요.':'조회할 다른 채널을 입력해 보세요.');return;}
  const fragment=document.createDocumentFragment();
  list.forEach(ch=>{
    const card=document.createElement('article');card.className='channel-card';
    const top=document.createElement('div');top.className='card-top';
    const avatar=document.createElement('img');avatar.className='avatar';avatar.alt='';avatar.loading='lazy';avatar.referrerPolicy='no-referrer';if(ch.avatar)avatar.src=ch.avatar;
    const info=document.createElement('div');info.className='card-info';const h=document.createElement('h3');h.textContent=ch.title;h.title=ch.title;const desc=document.createElement('p');desc.textContent=ch.description || '유튜브 채널';desc.title=ch.description;
    info.append(h,desc);top.append(avatar,info);
    const actions=document.createElement('div');actions.className='card-actions';
    const direct=document.createElement('button');direct.type='button';direct.className='subscribe';
    const ownerMode=state.viewMine && Boolean(state.token && Date.now()<state.expires);
    if(ownerMode){
      direct.textContent='구독 취소';direct.classList.add('unsubscribe');
      direct.title='이 채널의 구독을 취소합니다 (확인 후 실행)';
      direct.disabled=!ch.subscriptionId;
      if(!ch.subscriptionId) direct.title='구독 ID를 가져오지 못했습니다. 새로고침 후 다시 시도하세요.';
      direct.addEventListener('click',()=>unsubscribe(ch,direct));
    }else{
      direct.textContent=state.subscribed.has(ch.id)?'✓ 구독 중':'바로 구독';
      direct.disabled=state.subscribed.has(ch.id);if(direct.disabled)direct.classList.add('done');
      direct.title='Google 계정 인증 후 웹사이트에서 구독';direct.addEventListener('click',()=>subscribe(ch.id,direct));
    }
    const link=document.createElement('button');link.type='button';link.className='outlink primary-link';link.textContent='유튜브에서 구독 ↗';link.title='Chrome에서 설정한 YouTube 링크 열기 방식으로 이동';link.addEventListener('click',()=>openYoutubeSubscription(ch.id));
    actions.append(link,direct);card.append(top,actions);fragment.append(card);
  });root.append(fragment);
}
function waitForGIS(){return new Promise((resolve,reject)=>{if(window.google?.accounts?.oauth2) return resolve();let n=0;const timer=setInterval(()=>{if(window.google?.accounts?.oauth2){clearInterval(timer);resolve();}else if(++n>=50){clearInterval(timer);reject(new Error('Google 로그인 스크립트 로딩에 실패했습니다. 네트워크 또는 광고 차단 설정을 확인해 주세요.'));}},100);});}
async function connect(forceAccountSelection = false) {
 const clientId=setting('OAUTH_CLIENT_ID');if(!clientId) { throw new Error('Google OAuth 설정이 누락되었습니다. 운영자에게 문의해 주세요.'); }
 if(!forceAccountSelection && state.token && Date.now()<state.expires) return;
 if(state.authResolve) throw new Error('Google 로그인 창이 이미 열려 있습니다.');
 await waitForGIS();
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{if(state.authResolve){state.authResolve=null;reject(new Error('로그인 요청 시간이 초과되었습니다. 다시 시도해 주세요.'));}},120000);
  state.authResolve={resolve,reject};
  try {
    state.tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/youtube',callback:response=>{
      clearTimeout(timeout);state.authResolve=null;
      if(response.error || !response.access_token){reject(new Error(response.error_description || response.error || '로그인을 취소했거나 권한이 승인되지 않았습니다.'));return;}
      // A successful account switch invalidates account-specific subscriptions and identity.
      // If the user cancels the Google chooser, the old connection is left intact.
      if(forceAccountSelection){
        state.connectedChannel=null;
        state.subscribed=new Set();
        if(state.viewMine){
          state.viewMine=false;
          state.source=null;
          state.items=[];
          state.nextPage=null;
          $('sourceBanner').classList.add('hidden');
          $('syncNote').classList.add('hidden');
          render();
          setBusy(false);
        } else if(state.items.length){render();}
      }
      state.token=response.access_token;state.expires=Date.now()+(Number(response.expires_in || 3500)-40)*1000;
      $('loginBtn').textContent='✓ 계정 연결됨';toast('Google 계정 인증이 완료되었습니다.','success');resolve();loadMyChannel().catch(()=>{});
    },error_callback:err=>{clearTimeout(timeout);state.authResolve=null;reject(new Error(err?.message || err?.type || '계정 연결이 취소되었습니다.'));}});
    state.tokenClient.requestAccessToken({prompt:forceAccountSelection?'select_account consent':'consent'});
  }catch(err){clearTimeout(timeout);state.authResolve=null;reject(err);}
 });
}
async function loadMyChannel() {
  if (!state.token || Date.now() >= state.expires) return;
  try {
    const result = await youtube('channels', {part:'id', mine:true, maxResults:50}, {auth:true});
    const ids = (result.items || []).map(item => item.id).filter(Boolean);
    // With multiple brand channels, use mine=true only when the OAuth identity is unambiguous.
    state.connectedChannel = ids.length === 1 ? ids[0] : null;
    // URL 검색은 항상 입력한 채널의 공개 목록을 조회합니다. 내 목록은 별도 버튼으로만 전환합니다.
  } catch(err) {console.warn('OAuth 채널 확인 실패:',errorString(err));}
}
async function refreshMine() {
  if(!state.token)return;
  const subIds=new Set();let cursor;
  try {let pages=0;do{const r=await youtube('subscriptions',{part:'snippet',mine:true,maxResults:50,pageToken:cursor},{auth:true});(r.items||[]).forEach(x=>{if(x.snippet?.resourceId?.channelId)subIds.add(x.snippet.resourceId.channelId);});cursor=r.nextPageToken;pages++;}while(cursor && pages<20); // API 보호: 최대 1000개 점검
  state.subscribed=subIds;if(state.items.length)render();
  }catch(err){console.warn('기존 구독 여부 확인 실패:',errorString(err));}
}
async function subscribe(id, btn) {
 if (state.busy || tooSoon('subscribe:'+id, 8000)) return;
 if (!/^UC[\w-]{22}$/.test(id)) return;
 if(state.subscribed.has(id))return;
 // 각 클릭마다 개별 요청. 사용자의 명시적 클릭 없이는 구독하지 않음.
 btn.disabled=true;const original=btn.textContent;btn.textContent='확인 중…';
 try {
   if(!state.token || Date.now()>=state.expires) await connect();
   // 다른 Google 계정이 선택될 수 있으므로 OAuth 계정 연결 이후 다시 별도의 버튼 클릭 요청
   if(!original.includes('확인 중') && original==='바로 구독' && state.token && Date.now()<state.expires){
     const result=await youtube('subscriptions',{part:'snippet'},{auth:true,method:'POST',body:{snippet:{resourceId:{kind:'youtube#channel',channelId:id}}}});
     if(result.id){state.subscribed.add(id);toast('구독이 완료되었습니다.','success');render();return;}
     throw new Error('API에서 구독 완료를 확인하지 못했습니다.');
   }
 }catch(err){ const message=errorString(err);if(/already subscribed|subscriptionDuplicate|duplicate/i.test(message)){state.subscribed.add(id);toast('이미 구독 중인 채널입니다.','success');render();return;} toast(message,'error'); }
 finally{btn.disabled=false;btn.textContent=original;}
}
async function unsubscribe(channel, button){
  if (button.disabled || tooSoon('unsubscribe:'+channel.id, 8000)) return;
  if(!state.viewMine || !state.source || !channel.subscriptionId){
    toast('구독 취소는 인증된 내 목록/소유자 조회에서만 가능합니다.','error');return;
  }
  if(!state.token || Date.now()>=state.expires){toast('Google 계정을 다시 연결해 주세요.','error');return;}
  const confirmed=window.confirm('「'+channel.title+'」 채널의 구독을 취소하시겠습니까?\n이 작업은 연결한 YouTube 계정에 적용됩니다.');
  if(!confirmed)return;
  button.disabled=true;button.textContent='취소 중…';
  try{
    await youtube('subscriptions',{id:channel.subscriptionId},{auth:true,method:'DELETE'});
    state.items=state.items.filter(x=>x.id!==channel.id);
    state.subscribed.delete(channel.id);
    state.items.forEach((x,i)=>{x.order=i;});
    sourceDisplay(state.source);
    $('resultsSubtitle').textContent=state.items.length.toLocaleString('ko-KR')+'개 · 구독 취소 반영 완료';
    render();
    toast('「'+channel.title+'」 구독을 취소했습니다.','success');
    // Do not automatically re-fetch stale public snapshots immediately after a confirmed DELETE.
  }catch(err){button.disabled=false;button.textContent='구독 취소';toast('구독 취소 실패: '+errorString(err),'error');}
}
// Bulk subscriptions are initiated only after explicit per-operation consent.
// To conserve quota, scan existing subscriptions once, then send sequential writes.
const BULK_DELAY_MS=950;
const bulkSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validChannelId=id=>/^UC[\w-]{22}$/.test(id);
function bulkEligible(){return [...new Map(state.items.filter(x=>validChannelId(x.id)).map(x=>[x.id,x])).values()];}
function bulkProgress(done,total,ok,skipped,failed,status=''){
  $('bulkProgressArea').classList.remove('hidden');
  $('bulkProgressFill').style.width = (total ? (100*done/total) : 100)+'%';
  $('bulkProgressText').textContent=`${done}/${total} 처리 · 구독 성공 ${ok} · 이미 구독 중 ${skipped} · 실패 ${failed}` + (status?'\n'+status:'');
}
function showBulkDialog(){
  if(state.bulk.running || !state.items.length || state.viewMine || state.busy)return;
  const channels=bulkEligible();
  $('bulkConsent').checked=false;
  $('bulkStartBtn').disabled=true;
  $('bulkTotal').textContent=channels.length.toLocaleString('ko-KR');
  $('bulkQuota').textContent=(channels.length*50).toLocaleString('ko-KR');
  $('bulkProgressArea').classList.add('hidden');
  $('bulkSubscribeDescription').textContent=`현재 불러온 ${channels.length.toLocaleString('ko-KR')}개 채널을 연결할 YouTube 계정에서 구독합니다. 이미 구독 중인 채널은 가능한 한 건너뜁니다.`;
  $('bulkCancelBtn').textContent='닫기';
  $('bulkStartBtn').textContent='모두 구독 시작';
  $('bulkSubscribeDialog').showModal();
}
async function loadExistingForBulk(){
  const ids=new Set();let pageToken;let pages=0;
  do {
    const result=await youtube('subscriptions',{part:'snippet',mine:true,maxResults:50,pageToken},{auth:true});
    for(const item of result.items||[]){const id=item.snippet?.resourceId?.channelId;if(id)ids.add(id);}
    pageToken=result.nextPageToken;
    if(++pages>250)throw new Error('구독 목록 페이지가 비정상적으로 많아 안전하게 중단했습니다.');
  } while(pageToken);
  return ids;
}
async function executeBulk(){
  if(state.bulk.running || !state.items.length || state.viewMine || !($('bulkConsent').checked))return;
  state.bulk.running=true;state.bulk.cancel=false;
  $('bulkStartBtn').disabled=true;
  $('bulkCancelBtn').textContent='중단';
  $('closeBulkSubscribeBtn').disabled=true;
  setBusy(true);
  const targets=bulkEligible();let done=0,success=0,skipped=0,failed=0,consecutive=0,reason='';
  try{
    if(!state.token || Date.now()>=state.expires){
      $('bulkProgressArea').classList.remove('hidden');
      $('bulkProgressText').textContent='Google 계정을 연결해 주세요.';
      // OAuth account chooser is explicitly triggered by clicking the start button.
      await connect();
    }
    // The full authenticated subscription snapshot is required to avoid 50-unit duplicate attempts.
    const existing=await loadExistingForBulk();
    state.subscribed=new Set(existing);
    render();
    bulkProgress(0,targets.length,0,0,0,'기존 구독을 확인했습니다.');
    for (const channel of targets){
      if(state.bulk.cancel){reason='사용자가 중단했습니다.';break;}
      if(existing.has(channel.id)){
        skipped++;done++;bulkProgress(done,targets.length,success,skipped,failed);continue;
      }
      try{
        const result=await youtube('subscriptions',{part:'snippet'},{auth:true,method:'POST',body:{snippet:{resourceId:{kind:'youtube#channel',channelId:channel.id}}}});
        if(!result.id)throw new Error('YouTube가 구독 완료 응답을 반환하지 않았습니다.');
        existing.add(channel.id);state.subscribed.add(channel.id);success++;consecutive=0;
      }catch(err){
        if(err.reason==='subscriptionDuplicate'){
          existing.add(channel.id);state.subscribed.add(channel.id);skipped++;consecutive=0;
        }else{
          failed++;consecutive++;
          const stopReasons=['quotaExceeded','dailyLimitExceeded','rateLimitExceeded','userRateLimitExceeded','subscriptionForbidden','insufficientPermissions','forbidden','PERMISSION_DENIED'];
          if(stopReasons.includes(err.reason) || err.status===401 || err.status===429 || consecutive>=3){
            reason='API 제한 또는 인증 오류로 중단: '+errorString(err);done++;bulkProgress(done,targets.length,success,skipped,failed,reason);break;
          }
        }
      }
      done++;bulkProgress(done,targets.length,success,skipped,failed);
      if(done%5===0)render();
      // Cancellable delay avoids bursts and is not retried on rate/quota denial.
      if(done<targets.length){for(let i=0;i<5&&!state.bulk.cancel;i++)await bulkSleep(BULK_DELAY_MS/5);}
    }
    render();
    bulkProgress(done,targets.length,success,skipped,failed,reason || '작업이 종료되었습니다.');
    toast(`모두 구독 결과: 성공 ${success}개 · 기존 구독 ${skipped}개 · 실패 ${failed}개`+(reason?' · 중단됨':''),reason?'error':'success');
  }catch(err){
    reason=errorString(err);bulkProgress(done,targets.length,success,skipped,failed,'조회/연결 실패: '+reason);
    toast('모두 구독 실행 실패: '+reason,'error');
  }finally{
    state.bulk.running=false;state.bulk.cancel=false;
    $('closeBulkSubscribeBtn').disabled=false;
    $('bulkCancelBtn').textContent='닫기';
    $('bulkStartBtn').textContent='완료';
    $('bulkStartBtn').disabled=true;
    setBusy(false);
  }
}
$('bulkSubscribeBtn').addEventListener('click',showBulkDialog);
$('bulkConsent').addEventListener('change',()=>{$('bulkStartBtn').disabled=!$('bulkConsent').checked;});
$('bulkStartBtn').addEventListener('click',executeBulk);
$('bulkCancelBtn').addEventListener('click',()=>{if(state.bulk.running){state.bulk.cancel=true;$('bulkCancelBtn').textContent='중단 요청 중…';$('bulkCancelBtn').disabled=true;}else $('bulkSubscribeDialog').close();});
$('bulkSubscribeDialog').addEventListener('close',()=>{$('bulkCancelBtn').disabled=false;});
$('closeBulkSubscribeBtn').addEventListener('click',()=>{if(!state.bulk.running)$('bulkSubscribeDialog').close();});
$('bulkSubscribeDialog').addEventListener('cancel',event=>{if(state.bulk.running)event.preventDefault();});
$('bulkSubscribeDialog').addEventListener('click',event=>{if(event.target===event.currentTarget&&!state.bulk.running)event.currentTarget.close();});

function exportCsv(){if(!state.items.length)return;const csvCell=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const rows=[['채널명','채널 ID','채널 URL','설명','구독 공개 데이터 날짜'],...state.items.map(x=>[x.title,x.id,'https://www.youtube.com/channel/'+x.id,x.description,x.publishedAt])];const blob=new Blob(['\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='SubBridge_'+(state.source?.id||'subscriptions')+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}

// 브라우저 / 운영체제에서 설정한 링크 처리 규칙에 맡깁니다.
// YouTube PWA가 설치되어 있는 경우 Chrome이 앱으로 라우팅할 수 있습니다.
function openYoutubeSubscription(channelId){
  if(!/^UC[\w-]{22}$/.test(channelId)){
    toast('유효한 채널 ID가 아닙니다.','error');
    return;
  }
  const url='https://www.youtube.com/channel/'+encodeURIComponent(channelId)+'?sub_confirmation=1';
  // 버튼을 누르는 사용자 제스처에서 직접 열어 팝업 차단 가능성을 낮춥니다.
  window.open(url,'_blank','noopener,noreferrer');
}

$('clearInputBtn').addEventListener('click',()=>{$('channelInput').value='';$('channelInput').focus();});
$('authHelpBtn').addEventListener('click',()=>openHelpDialog('authHelpDialog'));
$('closeAuthHelpBtn').addEventListener('click',()=>$('authHelpDialog').close());
$('authHelpOkayBtn').addEventListener('click',()=>$('authHelpDialog').close());
$('loginBtn').addEventListener('click',async()=>{
  if(state.token && Date.now()<state.expires){
    openHelpDialog('accountChoiceDialog');
    return;
  }
  try{await connect();}catch(err){toast(errorString(err),'error');}
});
$('closeAccountChoiceBtn').addEventListener('click',()=>$('accountChoiceDialog').close());
$('keepAccountBtn').addEventListener('click',()=>{$('accountChoiceDialog').close();toast('현재 연결된 구글 계정을 유지합니다.','success');});
$('switchAccountBtn').addEventListener('click',async()=>{
  $('accountChoiceDialog').close();
  try { await connect(true); }
  catch(err){ toast(errorString(err),'error'); }
});
$('guideBtn').addEventListener('click',()=>openHelpDialog('guideDialog'));$('guideOkayBtn').addEventListener('click',()=>$('guideDialog').close());$('closeGuideBtn').addEventListener('click',()=>$('guideDialog').close());
$('searchForm').addEventListener('submit',event=>{
  event.preventDefault();
  // iOS Safari magnifies focused inputs under 16px. Remove keyboard focus before loading.
  const input=$('channelInput');
  const query=input.value;
  input.blur();
  if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
  search(query);
});
// Modal openers should not leave the close control in a focused/highlighted state.
for(const id of ['guideDialog','authHelpDialog','youtubeLinkHelpDialog','accountChoiceDialog']){
  const dialog=$(id);
  if(!dialog)continue;
  dialog.addEventListener('close',()=>{const active=document.activeElement;if(active instanceof HTMLElement&&dialog.contains(active))active.blur();});
}

$('mySubsBtn').addEventListener('click', async()=>{
  if(state.busy)return;
  try {
    if(!state.token || Date.now()>=state.expires)await connect();
    const data=await youtube('channels',{part:'snippet',mine:true,maxResults:50},{auth:true});
    const own=data.items?.[0];
    if(!own)throw new Error('연결된 Google 계정에서 YouTube 채널을 찾지 못했습니다.');
    if((data.items||[]).length>1)toast('여러 YouTube 채널이 있습니다. 로그인 시 선택된 채널 기준으로 표시됩니다.');
    state.viewMine=true;state.source=own;state.items=[];state.nextPage=null;
    $('filterInput').disabled=false;$('sortSelect').disabled=false;
    $('sourceBanner').classList.remove('hidden');
    await fetchPage(true);
    updateSourceModeHint();
  } catch(err){toast('내 목록 조회 실패: '+errorString(err),'error');}
});
// 조회 모드를 눈에 띄게 구분합니다. 공개 목록은 내 계정의 구독 현황과 다를 수 있습니다.
function updateSourceModeHint() {
  const subtitle = $('resultsSubtitle');
  if (!state.source || !subtitle) return;
  subtitle.dataset.sourceMode = state.viewMine ? 'authenticated' : 'public';
  $('sourceCountLabel').textContent = state.viewMine ? '소유자 인증 구독 채널' : '공개 API 구독 채널';
  const note = $('syncNote');
  note.classList.remove('hidden');
  if (state.viewMine) {
    note.textContent = '✓ 소유자 인증 조회 중입니다. 새로고침 시 Google 계정의 구독 목록을 다시 요청합니다. 다만 YouTube 서버의 갱신 지연은 제어할 수 없습니다.';
  } else {
    note.textContent = 'ⓘ 현재 공개 API로 조회 중입니다. 채널 소유자가 구독을 변경해도 공개 API 데이터 반영이 늦을 수 있습니다. 이 채널 소유자라면 [소유자 인증 조회]를 눌러 Google 계정을 인증한 후 새로고침하세요.';
  }
}
async function ensureOwnerVerified() {
  if (!state.source) throw new Error('먼저 조회할 유튜브 채널 URL을 입력해 주세요.');
  if (!state.token || Date.now() >= state.expires) await connect();
  // OAuth로 선택된 유튜브 채널의 실제 ID를 확인합니다.
  const channels = await youtube('channels',{part:'id,snippet',mine:true,maxResults:50},{auth:true});
  const ids = (channels.items || []).map(x=>x.id);
  if (!ids.includes(state.source.id)) {
    throw new Error('현재 연결된 YouTube 계정의 채널 ID가 조회 중인 채널과 다릅니다. Google 로그인에서 해당 채널(브랜드 계정 포함)을 선택해야 합니다.');
  }
  state.viewMine = true;
  updateSourceModeHint();
  return true;
}
$('ownerVerifyBtn').addEventListener('click',async()=>{
  if(state.busy || !state.source)return;
  try{
    await ensureOwnerVerified();
    toast('조회 대상 채널의 소유자 인증 완료. 인증된 구독 목록을 불러옵니다.','success');
    await refreshLatestSubscriptions();
  }catch(err){toast('소유자 인증 조회 실패: '+errorString(err),'error');}
});
async function preferAuthenticatedOwnSource() {
  if (state.viewMine || !state.source || !state.token || Date.now() >= state.expires) return false;
  // 공개 URL로 조회한 채널과 연결된 YouTube 계정이 같은 경우에만 모드 변경.
  if (!state.connectedChannel) await loadMyChannel();
  const matched = state.connectedChannel === state.source.id;
  if (matched) {
    state.viewMine = true;
    toast('연결한 본인 채널로 확인되어 인증된 내 구독 목록으로 갱신합니다.', 'success');
    return true;
  }
  return false;
}
// 새로고침은 이전 데이터를 보존한 채 모든 API 페이지를 다시 받아온 후 한 번에 교체합니다.
async function refreshLatestSubscriptions() {
  if (state.busy || !state.source) return;
  if (tooSoon('refresh:'+state.source.id, 10000)) {toast('불필요한 API 호출을 줄이기 위해 10초 내 중복 새로고침은 제한됩니다.');return;}
  const sourceId = state.source.id;
  // 이미 인증되어 있다면 동일한 본인 채널은 자동으로 mine=true 조회로 전환.
  // 인증 실패는 조용히 공개 조회로 대체하지 않고 화면에 명확히 알림.
  if (!state.viewMine && state.token && Date.now() < state.expires) {
    try { await preferAuthenticatedOwnSource(); }
    catch (error) { toast('본인 채널 확인 실패: ' + errorString(error) + ' · 공개 목록으로 조회합니다.', 'error'); }
  }
  const mine = state.viewMine;
  updateSourceModeHint();
  if (mine && (!state.token || Date.now() >= state.expires)) {
    toast('내 구독 목록을 갱신하려면 Google 계정을 다시 연결해 주세요.', 'error');
    return;
  }
  const previous = state.items;
  const beforeIds = new Set(previous.map(item => item.id));
  const freshItems = [];
  const seenIds = new Set();
  const visitedTokens = new Set();
  let cursor = null;
  let pages = 0;
  setBusy(true);
  $('refreshBtn').textContent = '↻ 갱신 중…';
  $('resultsSubtitle').textContent = mine ? '내 구독 변경사항 확인 중…' : '공개 구독 목록의 최신 상태 확인 중…';
  try {
    do {
      if (cursor && visitedTokens.has(cursor)) throw new Error('YouTube 페이지 토큰이 반복되어 조회를 중단했습니다.');
      if (cursor) visitedTokens.add(cursor);
      const data = await youtube('subscriptions', {
        part: 'snippet',
        ...(mine ? {mine: true} : {channelId: sourceId}),
        maxResults: 50,
        pageToken: cursor || undefined
      }, mine ? {auth: true} : {});
      for (const sub of data.items || []) {
        const id = sub.snippet?.resourceId?.channelId || '';
        if (!/^UC[\w-]{22}$/.test(id) || seenIds.has(id)) continue;
        seenIds.add(id);
        freshItems.push({
          id,
          subscriptionId: mine ? (sub.id || null) : null,
          title: sub.snippet?.title || '이름 없는 채널',
          description: sub.snippet?.description || '',
          avatar: avatarOf(sub.snippet),
          publishedAt: sub.snippet?.publishedAt || '',
          order: freshItems.length
        });
      }
      cursor = data.nextPageToken || null;
      pages++;
      $('resultsSubtitle').textContent = `최신 목록 확인 중 · ${freshItems.length.toLocaleString('ko-KR')}개 · ${pages}페이지`;
      if (cursor) await new Promise(resolve => setTimeout(resolve, 0));
    } while (cursor);
    // 한 번의 수동 새로고침에서 각 페이지는 한 번씩만 조회합니다. 자동 재조회 없음.
    if (state.source?.id !== sourceId || state.viewMine !== mine) return;
    const added = freshItems.filter(item => !beforeIds.has(item.id)).length;
    const removed = previous.filter(item => !seenIds.has(item.id)).length;
    state.items = freshItems;
    state.nextPage = null;
    $('moreWrap').classList.add('hidden');
    $('resultsSubtitle').textContent = `${freshItems.length.toLocaleString('ko-KR')}개 최신 조회 완료 · 추가 ${added}개 · 삭제 ${removed}개 · ${pages}페이지`;
    sourceDisplay(state.source);
    updateSourceModeHint();
    render();
    if (!freshItems.length) empty('구독 채널이 없습니다', '현재 API에서 반환된 구독 채널이 없습니다.');
    if (!mine) {
      updateSourceModeHint();
      toast('공개 API를 다시 조회했습니다. 변경사항이 보이지 않으면 채널 소유자 계정으로 「소유자 인증 조회」를 이용해 주세요. 공개 API의 반영 지연은 사이트가 제거할 수 없습니다.');
    } else {
      toast(added || removed ? `내 구독 변경사항 반영: 추가 ${added}개, 삭제 ${removed}개` : '최신 내 구독 목록을 재확인했지만 API에 아직 변경사항이 없습니다. YouTube 서버 반영이나 계정 선택 상태를 확인해 주세요.', added || removed ? 'success' : '');
    }
    if (mine) state.subscribed = new Set(freshItems.map(item => item.id));
  } catch (error) {
    state.items = previous;
    $('resultsSubtitle').textContent = `새로고침 실패 · 이전 목록 ${previous.length.toLocaleString('ko-KR')}개 유지`;
    toast('최신 목록 갱신 실패: ' + errorString(error), 'error');
  } finally {
    $('refreshBtn').textContent = '↻ 새로고침';
    setBusy(false);
  }
}
$('refreshBtn').addEventListener('click', refreshLatestSubscriptions);
$('moreBtn').addEventListener('click',()=>fetchPage(false));$('exportBtn').addEventListener('click',exportCsv);$('filterInput').addEventListener('input',render);$('sortSelect').addEventListener('change',render);
if(!setting('API_KEY')) {$('resultsSubtitle').textContent='사이트 API 설정이 필요합니다.';}
})();

// 구독 채널 리스트: YouTube 앱 링크 처리 도움말
document.getElementById('youtubeLinkHelpBtn').addEventListener('click', () => document.getElementById('youtubeLinkHelpDialog').showModal());
document.getElementById('closeYoutubeLinkHelpBtn').addEventListener('click', () => document.getElementById('youtubeLinkHelpDialog').close());
document.getElementById('youtubeLinkHelpOkayBtn').addEventListener('click', () => document.getElementById('youtubeLinkHelpDialog').close());
document.getElementById('youtubeLinkHelpDialog').addEventListener('click', (e) => { if(e.target === e.currentTarget) e.currentTarget.close(); });

// Allow backdrop clicking to close the two additional help dialogs, consistent
// with the existing YouTube-link help dialog. Clicks inside are ignored.
for (const dialogId of ['authHelpDialog', 'guideDialog']) {
  const dialog = document.getElementById(dialogId);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) dialog.close();
  });
}

// Keep the URL hint readable on narrow screens without shrinking iOS input text
// below 16px (which would trigger Safari's automatic input-focus zoom).
(() => {
  const input = document.getElementById('channelInput');
  if (!input) return;
  const mobileHint = '채널 URL 또는 @핸들 입력';
  const desktopHint = '유튜브 채널 URL 또는 @핸들 / UC로 시작하는 채널 ID';
  const mobileQuery = window.matchMedia('(max-width: 760px)');
  const updateHint = () => {
    input.placeholder = mobileQuery.matches ? mobileHint : desktopHint;
  };
  updateHint();
  mobileQuery.addEventListener?.('change', updateHint);
})();

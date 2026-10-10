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
const state = { source: null, viewMine: false, items: [], nextPage: null, busy: false, token: '', expires: 0, tokenClient: null, connectedChannel: null, subscribed: new Set(), authResolve: null, loginBusy: false };
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
function errorString(err) { const code = err?.reason || err?.message || String(err);const map = { quotaExceeded:'오늘의 YouTube API 할당량이 소진되었습니다.', dailyLimitExceeded:'오늘의 API 사용량 한도를 초과했습니다.', accessNotConfigured:'Google Cloud에서 YouTube Data API v3를 활성화해 주세요.', API_KEY_INVALID:'API 키가 올바르지 않습니다.', keyInvalid:'API 키를 확인해 주세요.', subscriptionForbidden:'이 채널은 구독 정보를 비공개로 설정했거나 구독 정보에 접근할 수 없습니다.', subscriptionDuplicate:'이미 구독 중인 채널입니다.', authenticatedUserAccountClosed:'이 계정에서는 YouTube를 사용할 수 없습니다.', insufficientPermissions:'유튜브 구독 권한이 승인되지 않았습니다.' }; return map[code] || code; }
function cleanError(status, result) { const e = result?.error || {};const reason = e.errors?.[0]?.reason || e.status || '';if (status === 403 && /subscription|forbidden/i.test(reason)) return {reason:'subscriptionForbidden'};if (status === 403 && /subscription/i.test(e.message || '')) return {reason:'subscriptionForbidden'};if (status === 403 && !reason && /not authorized/i.test(e.message || '')) return {reason:'subscriptionForbidden'};return {reason, message: e.message || '요청에 실패했습니다. (HTTP ' + status + ')'}; }
async function youtube(path, params = {}, options = {}) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = {};
  if (options.auth) {if (!state.token || Date.now() >= state.expires) throw new Error('Google 계정 연결이 만료되었습니다. 다시 연결해 주세요.');headers.Authorization = 'Bearer ' + state.token;}
  else { const key = setting('API_KEY'); if (!key) throw new Error('사이트 API 설정이 누락되었습니다. 운영자에게 문의해 주세요.'); url.searchParams.set('key', key); }
  if (options.body) headers['Content-Type'] = 'application/json';
  // Every GET is fresh at the browser/network layer. Google may still propagate updates asynchronously.
  if (!options.body && !options.method) url.searchParams.set('_subbridge_refresh', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  const response = await fetch(url, {method: options.method || 'GET', headers, cache: 'no-store', body: options.body ? JSON.stringify(options.body) : undefined});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw cleanError(response.status, body);
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
function setBusy(flag) {state.busy = flag;$('searchBtn').disabled = flag;$('mySubsBtn').disabled = flag;$('ownerVerifyBtn').disabled = flag || !state.source;$('moreBtn').disabled = flag;$('refreshBtn').disabled = flag || !state.source;$('exportBtn').disabled = flag || !state.items.length;}
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
      sourceDisplay(state.source);
      render();
      // 긴 목록은 브라우저가 중간에 화면을 갱신할 수 있게 합니다.
      if (cursor) await new Promise(resolve => setTimeout(resolve, 0));
    } while (cursor);
    completed = true;
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
async function search(raw) { if (state.busy) return; if (!setting('API_KEY')) { toast('사이트 인증 설정이 누락되었습니다. 운영자에게 문의해 주세요.','error');return; }
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
async function connect() {
 const clientId=setting('OAUTH_CLIENT_ID');if(!clientId) { throw new Error('Google OAuth 설정이 누락되었습니다. 운영자에게 문의해 주세요.'); }
 if(state.token && Date.now()<state.expires) return;
 if(state.authResolve) throw new Error('Google 로그인 창이 이미 열려 있습니다.');
 await waitForGIS();
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{if(state.authResolve){state.authResolve=null;reject(new Error('로그인 요청 시간이 초과되었습니다. 다시 시도해 주세요.'));}},120000);
  state.authResolve={resolve,reject};
  try {
    state.tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/youtube',callback:response=>{
      clearTimeout(timeout);state.authResolve=null;
      if(response.error || !response.access_token){reject(new Error(response.error_description || response.error || '로그인을 취소했거나 권한이 승인되지 않았습니다.'));return;}
      state.token=response.access_token;state.expires=Date.now()+(Number(response.expires_in || 3500)-40)*1000;
      $('loginBtn').textContent='✓ 계정 연결됨';toast('Google 계정 인증이 완료되었습니다.','success');resolve();loadMyChannel().then(() => refreshMine()).catch(()=>{});
    },error_callback:err=>{clearTimeout(timeout);state.authResolve=null;reject(new Error(err?.message || err?.type || '계정 연결이 취소되었습니다.'));}});
    state.tokenClient.requestAccessToken({prompt:'consent'});
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
$('loginBtn').addEventListener('click',async()=>{try{await connect();}catch(err){toast(errorString(err),'error');}});
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
for(const id of ['guideDialog','authHelpDialog','youtubeLinkHelpDialog']){
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
  const own = await youtube('channels', {part:'id', mine:true, maxResults:50}, {auth:true});
  const matched = (own.items || []).some(channel => channel.id === state.source.id);
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
    // 본인 계정은 API가 이전과 같은 목록을 반환하면 짧게 두 번 더 확인합니다.
    // 서버가 변경을 반환하기 전에는 임의로 목록에서 추가/삭제하지 않습니다.
    const sameAsBefore = () => seenIds.size === beforeIds.size && [...seenIds].every(id => beforeIds.has(id));
    if (mine && sameAsBefore()) {
      for (const waitMs of [1200, 2500]) {
        $('resultsSubtitle').textContent = `변경사항 재확인 중… · ${freshItems.length.toLocaleString('ko-KR')}개`;
        await new Promise(resolve => setTimeout(resolve, waitMs));
        const retryItems = [];
        const retrySeen = new Set();
        const retryTokens = new Set();
        let retryCursor = null;
        do {
          if (retryCursor && retryTokens.has(retryCursor)) throw new Error('YouTube 페이지 토큰이 반복되었습니다.');
          if (retryCursor) retryTokens.add(retryCursor);
          const data = await youtube('subscriptions', {part:'snippet',mine:true,maxResults:50,pageToken:retryCursor || undefined}, {auth:true});
          for (const sub of data.items || []) {
            const id = sub.snippet?.resourceId?.channelId || '';
            if (!/^UC[\w-]{22}$/.test(id) || retrySeen.has(id)) continue;
            retrySeen.add(id);
            retryItems.push({id,subscriptionId:sub.id || null,title:sub.snippet?.title || '이름 없는 채널',description:sub.snippet?.description || '',avatar:avatarOf(sub.snippet),publishedAt:sub.snippet?.publishedAt || '',order:retryItems.length});
          }
          retryCursor = data.nextPageToken || null;
        } while(retryCursor);
        freshItems.splice(0, freshItems.length, ...retryItems);
        seenIds.clear();
        for (const id of retrySeen) seenIds.add(id);
        if (!sameAsBefore()) break;
      }
    }
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
    if (mine) refreshMine().catch(() => {});
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

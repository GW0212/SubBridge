(() => {
'use strict';
const $ = id => document.getElementById(id);
const cfg = window.SUBBRIDGE_CONFIG || {};

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
const state = { source: null, items: [], nextPage: null, busy: false, token: '', expires: 0, tokenClient: null, connectedChannel: null, subscribed: new Set(), authResolve: null, loginBusy: false };
function toast(message, type = '') { const item = document.createElement('div');item.className = 'toast ' + type;item.textContent = message;$('toastHost').append(item);setTimeout(() => item.remove(), 5000); }
function errorString(err) { const code = err?.reason || err?.message || String(err);const map = { quotaExceeded:'오늘의 YouTube API 할당량이 소진되었습니다.', dailyLimitExceeded:'오늘의 API 사용량 한도를 초과했습니다.', accessNotConfigured:'Google Cloud에서 YouTube Data API v3를 활성화해 주세요.', API_KEY_INVALID:'API 키가 올바르지 않습니다.', keyInvalid:'API 키를 확인해 주세요.', subscriptionForbidden:'이 채널은 구독 정보를 비공개로 설정했거나 구독 정보에 접근할 수 없습니다.', subscriptionDuplicate:'이미 구독 중인 채널입니다.', authenticatedUserAccountClosed:'이 계정에서는 YouTube를 사용할 수 없습니다.', insufficientPermissions:'유튜브 구독 권한이 승인되지 않았습니다.' }; return map[code] || code; }
function cleanError(status, result) { const e = result?.error || {};const reason = e.errors?.[0]?.reason || e.status || '';if (status === 403 && /subscription|forbidden/i.test(reason)) return {reason:'subscriptionForbidden'};if (status === 403 && /subscription/i.test(e.message || '')) return {reason:'subscriptionForbidden'};if (status === 403 && !reason && /not authorized/i.test(e.message || '')) return {reason:'subscriptionForbidden'};return {reason, message: e.message || '요청에 실패했습니다. (HTTP ' + status + ')'}; }
async function youtube(path, params = {}, options = {}) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = {};
  if (options.auth) {if (!state.token || Date.now() >= state.expires) throw new Error('Google 계정 연결이 만료되었습니다. 다시 연결해 주세요.');headers.Authorization = 'Bearer ' + state.token;}
  else { const key = setting('API_KEY'); if (!key) throw new Error('사이트 API 설정이 누락되었습니다. 운영자에게 문의해 주세요.'); url.searchParams.set('key', key); }
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined});
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
function sourceDisplay(channel) { $('sourceBanner').classList.remove('hidden');$('sourceName').textContent = channel.snippet?.title || channel.id;$('sourceAvatar').src = avatarOf(channel.snippet);$('sourceUrl').href = 'https://www.youtube.com/channel/' + channel.id;$('sourceCount').textContent = state.items.length.toLocaleString('ko-KR'); }
function setBusy(flag) {state.busy = flag;$('searchBtn').disabled = flag;$('moreBtn').disabled = flag;$('refreshBtn').disabled = flag || !state.source;$('exportBtn').disabled = flag || !state.items.length;}
function empty(title, desc) { const root = $('channelGrid');root.replaceChildren();const emptyEl = document.createElement('div');emptyEl.className='empty';const icon=document.createElement('div');icon.className='empty-icon';icon.textContent='⌁';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=desc;emptyEl.append(icon,h,p);root.append(emptyEl); }
// 공개 구독 목록은 각 요청에서 최대 50개를 받습니다.
// API가 다음 페이지 토큰을 제공하는 동안 자동으로 조회합니다.
async function fetchPage(reset) {
  if (!state.source || state.busy) return;
  setBusy(true);
  $('moreWrap').classList.add('hidden');
  $('moreBtn').textContent = '남은 목록 이어서 불러오기 ↓';
  const sourceId = state.source.id;
  if (reset) { state.items = []; state.nextPage = null; }
  let cursor = reset ? null : state.nextPage;
  let pages = 0;
  const visited = new Set();
  let completed = false;
  let failed = false;
  $('resultsSubtitle').textContent = '공개 구독 목록을 불러오는 중…';
  try {
    do {
      if (cursor && visited.has(cursor)) throw new Error('YouTube에서 동일한 다음 페이지를 반복 반환했습니다. 잠시 후 새로고침해 주세요.');
      if (cursor) visited.add(cursor);
      const data = await youtube('subscriptions', {
        part: 'snippet', channelId: sourceId, maxResults: 50,
        pageToken: cursor || undefined
      });
      if (state.source?.id !== sourceId) return;
      const existing = new Set(state.items.map(x => x.id));
      for (const sub of data.items || []) {
        const id = sub.snippet?.resourceId?.channelId || '';
        if (!/^UC[\w-]{22}$/.test(id) || existing.has(id)) continue;
        existing.add(id);
        state.items.push({
          id,
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
    $('resultsSubtitle').textContent = `${state.items.length.toLocaleString('ko-KR')}개 조회 완료 · ${pages}페이지`; 
    if (!state.items.length) empty('공개 구독 채널이 없습니다', '공개 설정된 구독 채널이 없을 수 있습니다.');
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
  state.items=[];state.nextPage=null;state.source=null;$('moreWrap').classList.add('hidden');$('filterInput').disabled=true;$('sortSelect').disabled=true;
  try { state.source=await resolveChannel(raw); }catch(err){empty('채널을 찾을 수 없습니다',errorString(err));$('resultsSubtitle').textContent='채널 조회 실패';toast(errorString(err),'error');}finally{setBusy(false);}
  if (state.source) await fetchPage(true);
}
function render() {
  const word=$('filterInput').value.trim().toLocaleLowerCase('ko');
  let list=state.items.filter(x=>[x.title,x.description].some(t=>t.toLocaleLowerCase('ko').includes(word)));
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
    const direct=document.createElement('button');direct.type='button';direct.className='subscribe';direct.textContent=state.subscribed.has(ch.id)?'✓ 구독 중':'바로 구독';direct.disabled=state.subscribed.has(ch.id);if(direct.disabled)direct.classList.add('done');direct.title='Google 계정 인증 후 웹사이트에서 구독';direct.addEventListener('click',()=>subscribe(ch.id,direct));
    const link=document.createElement('button');link.type='button';link.className='outlink primary-link';link.textContent='유튜브에서 구독 ↗';link.title='앱 또는 웹사이트 열기 방식 선택';link.addEventListener('click',()=>chooseOpenTarget(ch.id));
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
      $('loginBtn').textContent='✓ 계정 연결됨';toast('Google 계정 인증이 완료되었습니다.','success');resolve();refreshMine().catch(()=>{});
    },error_callback:err=>{clearTimeout(timeout);state.authResolve=null;reject(new Error(err?.message || err?.type || '계정 연결이 취소되었습니다.'));}});
    state.tokenClient.requestAccessToken({prompt:'consent'});
  }catch(err){clearTimeout(timeout);state.authResolve=null;reject(err);}
 });
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
function exportCsv(){if(!state.items.length)return;const csvCell=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const rows=[['채널명','채널 ID','채널 URL','설명','구독 공개 데이터 날짜'],...state.items.map(x=>[x.title,x.id,'https://www.youtube.com/channel/'+x.id,x.description,x.publishedAt])];const blob=new Blob(['\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='SubBridge_'+(state.source?.id||'subscriptions')+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}

// 사용자별 열기 방식. 사이트 설정은 브라우저 로컬 저장소에만 저장됩니다.
const OPEN_PREF_KEY = 'subbridge_youtube_open_preference_v1';
let pendingOpenChannel = null;
function getOpenPreference(){try{const v=localStorage.getItem(OPEN_PREF_KEY);return v==='app'||v==='web'?v:null;}catch(_){return null;}}
function storeOpenPreference(value){try{if(value)localStorage.setItem(OPEN_PREF_KEY,value);else localStorage.removeItem(OPEN_PREF_KEY);}catch(_){}}
function subscriptionUrl(channelId){
  return 'https://www.youtube.com/channel/'+channelId+'?sub_confirmation=1';
}
function launchTarget(id,mode){
  if(!/^UC[\w-]{22}$/.test(id)){toast('유효한 채널 ID가 아닙니다.','error');return;}
  const url=subscriptionUrl(id);
  if(mode==='web'){
    // 기존 버전의 _blank 새 창 이동은 Chrome의 설치된 YouTube PWA 링크 캡처 대상이었습니다.
    // 현재 탭 내 이동은 새 프레임 생성이 없어 캡처를 피할 가능성이 더 높습니다.
    // 브라우저 정책에 따라 완전한 강제는 불가능합니다.
    window.location.assign(url);
    return;
  }
  // 앱 열기는 브라우저/운영체제의 기본 링크 처리 정책에 맡깁니다.
  const tab=window.open(url,'_blank','noopener,noreferrer');
  if(!tab){toast('팝업이 차단되었습니다. 새 탭 허용 후 다시 시도해 주세요.','error');}
}
function showOpenChoice(id){
  pendingOpenChannel=id;
  $('rememberOpenChoice').checked=false;
  $('openChoiceHint').textContent=id?'구독할 채널을 여는 방법을 선택하세요.':'기본 열기 방식을 변경할 수 있습니다.';
  $('openChoiceDialog').showModal();
}
function chooseOpenTarget(id){
  const choice=getOpenPreference();
  if(choice){launchTarget(id,choice);return;}
  showOpenChoice(id);
}
function selectOpenTarget(mode){
  const id=pendingOpenChannel;
  const persist=$('rememberOpenChoice').checked;
  if(persist){storeOpenPreference(mode);toast(mode==='app'?'기본 열기 방식: 유튜브 앱':'기본 열기 방식: 웹사이트','success');}
  $('openChoiceDialog').close();
  pendingOpenChannel=null;
  if(id)launchTarget(id,mode);
}
$('launchAppBtn').addEventListener('click',()=>selectOpenTarget('app'));
$('launchWebBtn').addEventListener('click',()=>selectOpenTarget('web'));
$('closeOpenChoiceBtn').addEventListener('click',()=>$('openChoiceDialog').close());
$('openChoiceDialog').addEventListener('close',()=>{pendingOpenChannel=null;});
$('openPrefsBtn').addEventListener('click',()=>showOpenChoice(null));
$('resetOpenPrefBtn').addEventListener('click',()=>{storeOpenPreference(null);$('rememberOpenChoice').checked=false;toast('저장된 열기 방식이 초기화되었습니다.','success');});
$('copyChannelUrlBtn').addEventListener('click',async()=>{
  if(!pendingOpenChannel){toast('구독 목록에서 채널을 선택하면 링크를 복사할 수 있습니다.');return;}
  const url=subscriptionUrl(pendingOpenChannel);
  try{await navigator.clipboard.writeText(url);toast('채널 링크를 복사했습니다.','success');}catch(_){toast('링크 복사에 실패했습니다.','error');}
});

$('clearInputBtn').addEventListener('click',()=>{$('channelInput').value='';$('channelInput').focus();});
$('authHelpBtn').addEventListener('click',()=>$('authHelpDialog').showModal());
$('closeAuthHelpBtn').addEventListener('click',()=>$('authHelpDialog').close());
$('authHelpOkayBtn').addEventListener('click',()=>$('authHelpDialog').close());
$('loginBtn').addEventListener('click',async()=>{try{await connect();}catch(err){toast(errorString(err),'error');}});
$('guideBtn').addEventListener('click',()=>$('guideDialog').showModal());$('guideOkayBtn').addEventListener('click',()=>$('guideDialog').close());$('closeGuideBtn').addEventListener('click',()=>$('guideDialog').close());
$('searchForm').addEventListener('submit',event=>{event.preventDefault();search($('channelInput').value);});
$('refreshBtn').addEventListener('click',()=>fetchPage(true));
$('moreBtn').addEventListener('click',()=>fetchPage(false));$('exportBtn').addEventListener('click',exportCsv);$('filterInput').addEventListener('input',render);$('sortSelect').addEventListener('change',render);
if(!setting('API_KEY')) {$('resultsSubtitle').textContent='사이트 API 설정이 필요합니다.';}
})();

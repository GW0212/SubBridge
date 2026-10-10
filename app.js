(() => {
'use strict';
const $ = id => document.getElementById(id);
const cfg = window.SUBBRIDGE_CONFIG || {};
const localKey = 'subbridge_credentials_v1';
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

let saved = {};
try { saved = JSON.parse(localStorage.getItem(localKey) || '{}') || {}; } catch (_) {}
const setting = name => (typeof saved[name] === 'string' && saved[name].trim()) || String(cfg[name] || '').trim();
const state = { source: null, items: [], nextPage: null, busy: false, token: '', expires: 0, tokenClient: null, connectedChannel: null, subscribed: new Set(), authResolve: null, loginBusy: false };
function toast(message, type = '') { const item = document.createElement('div');item.className = 'toast ' + type;item.textContent = message;$('toastHost').append(item);setTimeout(() => item.remove(), 5000); }
function errorString(err) { const code = err?.reason || err?.message || String(err);const map = { quotaExceeded:'오늘의 YouTube API 할당량이 소진되었습니다.', dailyLimitExceeded:'오늘의 API 사용량 한도를 초과했습니다.', accessNotConfigured:'Google Cloud에서 YouTube Data API v3를 활성화해 주세요.', API_KEY_INVALID:'API 키가 올바르지 않습니다.', keyInvalid:'API 키를 확인해 주세요.', subscriptionForbidden:'이 채널은 구독 정보를 비공개로 설정했거나 구독 정보에 접근할 수 없습니다.', subscriptionDuplicate:'이미 구독 중인 채널입니다.', authenticatedUserAccountClosed:'이 계정에서는 YouTube를 사용할 수 없습니다.', insufficientPermissions:'유튜브 구독 권한이 승인되지 않았습니다.' }; return map[code] || code; }
function cleanError(status, result) { const e = result?.error || {};const reason = e.errors?.[0]?.reason || e.status || '';if (status === 403 && /subscription|forbidden/i.test(reason)) return {reason:'subscriptionForbidden'};if (status === 403 && /subscription/i.test(e.message || '')) return {reason:'subscriptionForbidden'};if (status === 403 && !reason && /not authorized/i.test(e.message || '')) return {reason:'subscriptionForbidden'};return {reason, message: e.message || '요청에 실패했습니다. (HTTP ' + status + ')'}; }
async function youtube(path, params = {}, options = {}) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = {};
  if (options.auth) {if (!state.token || Date.now() >= state.expires) throw new Error('Google 계정 연결이 만료되었습니다. 다시 연결해 주세요.');headers.Authorization = 'Bearer ' + state.token;}
  else { const key = setting('API_KEY'); if (!key) throw new Error('API 키가 설정되지 않았습니다. 우측 상단 설정을 확인해 주세요.'); url.searchParams.set('key', key); }
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
async function fetchPage(reset) {
  if (!state.source || state.busy) return;
  setBusy(true);
  $('moreBtn').textContent='불러오는 중…';
  try {
    const data = await youtube('subscriptions',{part:'snippet',channelId:state.source.id,maxResults:50,pageToken:reset ? undefined : state.nextPage});
    const entries=(data.items || []).map((sub, idx) => ({
      id:sub.snippet?.resourceId?.channelId || '',
      title:sub.snippet?.title || '이름 없는 채널',
      description:sub.snippet?.description || '',
      avatar:avatarOf(sub.snippet),
      publishedAt:sub.snippet?.publishedAt || '', order:state.items.length + idx
    })).filter(x => /^UC[\w-]{22}$/.test(x.id));
    const old = new Set(state.items.map(x => x.id));state.items.push(...entries.filter(x => !old.has(x.id)));
    state.nextPage = data.nextPageToken || null;
    $('moreWrap').classList.toggle('hidden',!state.nextPage);
    $('resultsSubtitle').textContent = state.items.length.toLocaleString('ko-KR') + '개 불러옴' + (state.nextPage ? ' · 더 불러올 수 있습니다' : ' · 조회 완료');
    $('filterInput').disabled = false;$('sortSelect').disabled = false;sourceDisplay(state.source);render();
    if (reset && !state.items.length) empty('공개 구독 채널이 없습니다','해당 계정이 구독 정보를 공개했더라도 공개된 구독 채널이 없을 수 있습니다.');
  } catch(err) { toast(errorString(err),'error');if (reset) { $('resultsSubtitle').textContent = '목록을 불러오지 못했습니다.';empty('구독 목록 조회 실패',errorString(err)); } }
  finally {setBusy(false);$('moreBtn').textContent='다음 채널 더 불러오기 ↓';}
}
async function search(raw) { if (state.busy) return; if (!setting('API_KEY')) { $('settingsDialog').showModal();toast('먼저 Google Cloud API 키를 설정해 주세요.','error');return; }
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
    const link=document.createElement('a');link.className='outlink';link.href='https://www.youtube.com/channel/'+ch.id+'?sub_confirmation=1';link.target='_blank';link.rel='noopener noreferrer';link.textContent='유튜브에서 구독 ↗';link.title='유튜브에서 구독 여부를 확인하세요';
    actions.append(direct,link);card.append(top,actions);fragment.append(card);
  });root.append(fragment);
}
function waitForGIS(){return new Promise((resolve,reject)=>{if(window.google?.accounts?.oauth2) return resolve();let n=0;const timer=setInterval(()=>{if(window.google?.accounts?.oauth2){clearInterval(timer);resolve();}else if(++n>=50){clearInterval(timer);reject(new Error('Google 로그인 스크립트 로딩에 실패했습니다. 네트워크 또는 광고 차단 설정을 확인해 주세요.'));}},100);});}
async function connect() {
 const clientId=setting('OAUTH_CLIENT_ID');if(!clientId) { $('settingsDialog').showModal();throw new Error('Google OAuth 클라이언트 ID를 먼저 설정해 주세요.'); }
 if(state.token && Date.now()<state.expires) return;
 if(state.authResolve) throw new Error('Google 로그인 창이 이미 열려 있습니다.');
 await waitForGIS();
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{if(state.authResolve){state.authResolve=null;reject(new Error('로그인 요청 시간이 초과되었습니다. 다시 시도해 주세요.'));}},120000);
  state.authResolve={resolve,reject};
  try {
    state.tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/youtube.force-ssl',callback:response=>{
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
function openSettings(){ $('apiKeyInput').value=setting('API_KEY');$('clientIdInput').value=setting('OAUTH_CLIENT_ID');$('settingsDialog').showModal(); }
$('settingsBtn').addEventListener('click',openSettings);
$('saveSettingsBtn').addEventListener('click',()=>{ const newApi=$('apiKeyInput').value.trim(),newClient=$('clientIdInput').value.trim();if(newClient && !/^\d+-[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(newClient)){toast('OAuth 클라이언트 ID 형식을 확인해 주세요.','error');return;}saved={API_KEY:newApi,OAUTH_CLIENT_ID:newClient};try{localStorage.setItem(localKey,JSON.stringify(saved));}catch(_){toast('브라우저 설정을 저장할 수 없습니다.','error');return;}state.token='';state.expires=0;state.subscribed.clear();$('loginBtn').textContent='Google 계정 연결';$('settingsDialog').close();toast('연결 설정이 저장되었습니다.','success');});
$('clearSettingsBtn').addEventListener('click',()=>{localStorage.removeItem(localKey);saved={};$('apiKeyInput').value=setting('API_KEY');$('clientIdInput').value=setting('OAUTH_CLIENT_ID');state.token='';state.expires=0;state.subscribed.clear();$('loginBtn').textContent='Google 계정 연결';toast('이 브라우저의 개인 설정을 삭제했습니다.','success');});
$('loginBtn').addEventListener('click',async()=>{try{await connect();}catch(err){toast(errorString(err),'error');}});
$('guideBtn').addEventListener('click',()=>$('guideDialog').showModal());$('guideOkayBtn').addEventListener('click',()=>$('guideDialog').close());$('closeGuideBtn').addEventListener('click',()=>$('guideDialog').close());
$('searchForm').addEventListener('submit',event=>{event.preventDefault();search($('channelInput').value);});
$('refreshBtn').addEventListener('click',()=>{state.items=[];state.nextPage=null;fetchPage(true);});
$('moreBtn').addEventListener('click',()=>fetchPage(false));$('exportBtn').addEventListener('click',exportCsv);$('filterInput').addEventListener('input',render);$('sortSelect').addEventListener('change',render);
if(!setting('API_KEY')) {$('resultsSubtitle').textContent='API 설정 후 공개 구독 목록을 조회할 수 있습니다.';}
})();

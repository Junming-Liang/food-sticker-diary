'use strict';
const $ = (s, root=document) => root.querySelector(s);
const app = $('#app'), sheet = $('#sheet');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => localDate(new Date());
function localDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function shiftDay(day, amount){const d=new Date(`${day}T12:00:00`);d.setDate(d.getDate()+amount);return localDate(d)}
function dateLabel(day){const d=new Date(`${day}T12:00:00`);return `${d.getMonth()+1}月${d.getDate()}日`}
const cats=[['breakfast','早餐','sun'],['lunch','午餐','spark'],['dinner','晚餐','sticker'],['snack','加餐','plus']];
const state={user:null,view:'today',day:today(),meals:[],water:0,layout:'list',category:'breakfast',image:null,shares:[],weights:[],weekly:[],shareToken:new URL(location.href).searchParams.get('share'),shared:null,scanVersion:0};
let toastTimer;

async function api(path, opts={}){
  const init={method:opts.method||'GET', credentials:'same-origin', headers:{}};
  if(opts.body instanceof FormData) init.body=opts.body;
  else if(opts.body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body)}
  const res=await fetch(`api/${path}`,init);
  const data=await res.json().catch(()=>({error:'服务暂时不可用，请重试'}));
  if(!res.ok) throw new Error(data.error||'操作没有完成，请重试');
  return data;
}
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3200)}
function formError(form,message){const el=$('.form-error',form);if(el){el.textContent=message;el.classList.add('visible')}else toast(message)}
function openSheet(content){sheet.className='dialog';sheet.innerHTML=`<div class="sheet-inner">${content}</div>`;if(!sheet.open)sheet.showModal();}
function closeSheet(){if(sheet.open)sheet.close();state.scanVersion++}
function sheetTop(title){return `<div class="sheet-top"><h2 id="sheet-title">${esc(title)}</h2><button class="icon-button" type="button" data-action="close" aria-label="关闭">${icon('close')}</button></div>`}
function round(n){return Math.round(Number(n)||0)}
function total(meals,key){return meals.reduce((sum,item)=>sum+Number(item[key]||0),0)}
function dayTitle(){return state.day===today()?`今天 · ${dateLabel(state.day)}`:dateLabel(state.day)}
function pic(meal,kind='sticker',token=null){
  const wanted=kind==='sticker'&&meal.has_sticker?'sticker':(meal.has_photo?'photo':null);
  if(!wanted)return `<span class="empty-thumb">${icon('image')}</span>`;
  const url=token?`api/shared/${encodeURIComponent(token)}/image/${meal.id}/${wanted}`:`api/meals/${meal.id}/${wanted}`;
  return `<img class="food-thumb" src="${url}" alt="${esc(meal.name)}" loading="lazy">`;
}
function nav(){return `<nav class="bottom-nav" aria-label="主要导航">
 ${[['today','home','记录'],['analysis','chart','分析'],['stickers','sticker','贴纸'],['profile','user','我的']].map(([view,ico,label])=>`<button class="nav-item ${state.view===view?'active':''}" data-action="nav" data-view="${view}" ${state.view===view?'aria-current="page"':''}>${icon(ico)}<span>${label}</span></button>`).join('')}
 <button class="nav-add" data-action="add" aria-label="添加饮食记录">${icon('plus')}</button></nav>`}
function topBar(title,sub='',actions=''){return `<header class="topbar"><div><h1 class="${title==='轻食日记'?'brand':'page-title'}">${title==='轻食日记'?'<span class="brand-mark"></span>':''}${esc(title)}</h1>${sub?`<div class="topbar-subtitle">${esc(sub)}</div>`:''}</div><div class="top-actions">${actions}</div></header>`}
function dateStrip(){
  const d=new Date(`${state.day}T12:00:00`);const weekday=d.getDay()||7;const monday=shiftDay(state.day,1-weekday);
  const labels=['一','二','三','四','五','六','日'];
  return `<div class="date-strip" aria-label="选择日期">${labels.map((w,i)=>{const date=shiftDay(monday,i);return `<button class="day ${state.day===date?'active':''} ${date===today()?'today':''}" data-action="date" data-day="${date}" aria-label="${date}" ${state.day===date?'aria-pressed="true"':''}><span class="day-label">${date===today()?'今天':`周${w}`}</span><span>${Number(date.slice(-2))}</span></button>`}).join('')}</div>`;
}
function ring(){
 const eaten=total(state.meals,'calories'), target=state.user.target, remain=Math.max(0,target-eaten), pct=Math.max(0,Math.min(1,eaten/target));
 return `<section class="summary" aria-label="今日热量"><div class="summary-side"><strong>${round(eaten)}</strong><span>已摄入</span></div><div class="ring"><svg viewBox="0 0 164 164" aria-hidden="true"><circle class="ring-base" cx="82" cy="82" r="68" fill="none" stroke-width="8"/><circle class="ring-value" cx="82" cy="82" r="68" fill="none" stroke-width="8" stroke-dasharray="${(pct*427.3).toFixed(1)} 427.3"/></svg><div class="ring-center"><strong>${round(remain)}</strong><span>${eaten>target?`已超出 ${round(eaten-target)} 千卡`:'剩余可摄入'}</span></div></div><div class="summary-side"><strong>${round(target)}</strong><span>每日目标</span></div></section>`;
}
function macroGrid(){
 const values=[['碳水',total(state.meals,'carbs'),'var(--green)'],['蛋白质',total(state.meals,'protein'),'var(--purple)'],['脂肪',total(state.meals,'fat'),'var(--yellow)']];const sum=values.reduce((n,v)=>n+v[1],0);
 return `<section class="macro-grid" aria-label="营养记录">${values.map(([name,value,color])=>`<div class="macro"><div class="macro-label"><span>${name}</span><strong>${round(value)}<small>g</small></strong></div><div class="track"><span style="--color:${color};width:${sum?Math.round(value/sum*100):0}%"></span></div></div>`).join('')}</section>`;
}
function mealGroups(){return `<div class="meals">${cats.map(([id,label,ico])=>{
 const items=state.meals.filter(x=>x.category===id),sum=total(items,'calories');
 return `<section class="meal-group"><div class="meal-group-header"><div class="meal-title"><div class="meal-glyph">${icon(ico==='sun'?'spark':ico)}</div><div><strong>${label}</strong><small>${round(sum)} 千卡</small></div></div><button class="add-mini" data-action="add" data-category="${id}" aria-label="添加${label}">${icon('plus')}</button></div>
 ${items.length?`<div class="meal-entries">${items.map(m=>`<button class="meal-row" data-action="edit" data-id="${m.id}">${pic(m)}<span class="food-info"><strong>${esc(m.name)}</strong><small>${round(m.grams)} 克</small></span><span class="food-cal">${round(m.calories)} 千卡</span></button>`).join('')}</div>`:`<p class="empty-group">还没有${label}记录</p>`}</section>`}).join('')}</div>`}
function stickerGrid(meals,token=null){if(!meals.length)return `<div class="no-records">${icon('sticker')}<strong>还没有食物贴纸</strong><p>${token?'这一天还没有饮食记录':'拍下你的下一餐，留下一张食物贴纸'}</p></div>`;
 return `<div class="sticker-grid">${meals.map(m=>`<div class="sticker-card"><button ${token?'':`data-action="edit" data-id="${m.id}"`} ${token?'disabled':''}>${pic(m,'sticker',token)}<strong>${esc(m.name)}</strong><small>${round(m.calories)} 千卡</small></button></div>`).join('')}</div>`}
function todayView(){const calendar=`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('chart')}</button>`;
 return `${topBar('轻食日记',dayTitle(),calendar)}${dateStrip()}${ring()}${macroGrid()}<div class="section-head"><h2>饮食记录</h2><div class="segmented" aria-label="记录显示方式"><button class="${state.layout==='list'?'active':''}" data-action="layout" data-layout="list" aria-label="列表" aria-pressed="${state.layout==='list'}">${icon('list')}</button><button class="${state.layout==='grid'?'active':''}" data-action="layout" data-layout="grid" aria-label="贴纸" aria-pressed="${state.layout==='grid'}">${icon('grid')}</button></div></div>${state.layout==='list'?mealGroups():stickerGrid(state.meals)}`}
function analysisView(){
 const days=Array.from({length:7},(_,i)=>shiftDay(state.day,i-6));const amounts=days.map(day=>total(state.weekly.filter(m=>m.day===day),'calories'));const max=Math.max(state.user.target,...amounts,1);
 return `${topBar('分析','看看最近的饮食节奏',`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('chart')}</button>`)}<section class="panel"><div class="panel-top"><div><h2>热量摄入</h2><p class="panel-note">${dateLabel(days[0])} 至 ${dateLabel(days[6])}</p></div>${icon('chart')}</div><div class="bars" aria-label="最近七天热量摄入">${days.map((day,i)=>`<div class="bar-column"><span class="bar-value">${amounts[i]?round(amounts[i]):''}</span><span class="bar ${amounts[i]?'':'empty'}" style="height:${Math.max(2,Math.round(amounts[i]/max*105))}px"></span><span class="bar-label">${day.slice(-2)}日</span></div>`).join('')}</div></section><section class="panel"><h2>这一天</h2><div class="stat-line"><span>摄入热量</span><strong>${round(total(state.meals,'calories'))} 千卡</strong></div><div class="stat-line"><span>记录餐食</span><strong>${state.meals.length} 项</strong></div><div class="stat-line"><span>饮水</span><strong>${state.water} 毫升</strong></div></section><p class="privacy-copy">营养数值为估算，可能因食材、份量和烹饪方式而不同。请结合实际情况调整。</p>`;
}
function stickersView(){return `${topBar('食物贴纸',dayTitle(),`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('chart')}</button>`)}${dateStrip()}<div class="share-banner"><h2>把今天的饮食分享给搭子</h2><p>生成可撤销的链接，对方可以查看当天的餐食和贴纸。</p><button class="button" data-action="share">${icon('share')}分享这一天</button></div>${stickerGrid(state.meals)}`}
function profileView(){const username=esc(state.user.username);return `${topBar('我的')}<div class="account"><div class="avatar">${esc(state.user.username.slice(0,1).toUpperCase())}</div><div><strong>${username}</strong><small>记录每一餐，照顾好自己</small></div></div><section class="panel"><div class="panel-top"><div><h2>今天喝水了吗</h2><p class="panel-note">每次增减 250 毫升</p></div>${icon('drop')}</div><div class="water-line"><div class="water-count"><strong>${state.water}</strong> <span>毫升</span></div><div class="stepper"><button data-action="water" data-amount="-250" aria-label="减少饮水">−</button><button data-action="water" data-amount="250" aria-label="增加饮水">+</button></div></div></section><div class="setting-list"><button class="setting-row" data-action="settings">${icon('spark')}<span>热量目标与识别设置<small>每日 ${state.user.target} 千卡 · ${state.user.provider==='local'?'本地识别':esc(state.user.provider)}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="weight">${icon('weight')}<span>体重记录<small>${state.weights.length?`${state.weights[0].weight} 千克 · ${state.weights[0].day}`:'记录今天的体重'}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="manage-shares">${icon('share')}<span>分享管理<small>查看或撤销分享链接</small></span>${icon('chevron')}</button></div><button class="button outline full" data-action="logout">退出登录</button><button class="text-button danger" data-action="delete-account" style="display:block;margin:10px auto 0">删除账号及数据</button><p class="privacy-copy">你的饮食数据默认仅自己可见，只有主动创建分享链接后其他人才能查看对应日期。识别结果仅供日常参考。</p>`}
function render(){
 if(state.shareToken){renderShared();return}
 if(!state.user){renderAuth();return}
 const content=state.view==='today'?todayView():state.view==='analysis'?analysisView():state.view==='stickers'?stickersView():profileView();
 app.innerHTML=`<main id="main" class="screen">${content}</main>${nav()}`;
}
function renderAuth(mode='login'){
 const registering=mode==='register';
 app.innerHTML=`<main id="main" class="auth-screen"><img class="auth-logo" src="icon-192.png" alt=""><h1>把每一餐，<br>轻轻记下来。</h1><p class="intro">拍照记录饮食，留下食物贴纸。<br>从今天开始，更了解自己的每一餐。</p><form id="auth-form" data-mode="${mode}"><label class="field"><span>用户名</span><input name="username" autocomplete="username" required minlength="2" maxlength="32" placeholder="输入用户名"></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="${registering?'new-password':'current-password'}" minlength="8" maxlength="128" required placeholder="至少 8 位"></label><p class="form-error" role="alert"></p><button class="button full" type="submit">${registering?'创建账号':'登录'}</button></form><p class="auth-switch">${registering?'已经有账号？':'还没有账号？'}<button data-action="auth-mode" data-mode="${registering?'login':'register'}">${registering?'直接登录':'创建账号'}</button></p><p class="auth-foot">数据默认仅自己可见，分享由你决定。<br>食物热量与营养为估算值，请按实际情况调整。</p></main>`;
}
function renderShared(){
 if(!state.shared){app.innerHTML=`<main id="main" class="screen no-nav">${topBar('查看分享')}<div class="no-records">${icon('lock')}<strong>分享链接无效或已过期</strong><p>请联系分享者重新发送链接</p></div><p><a href="./" class="button secondary">打开轻食日记</a></p></main>`;return}
 const s=state.shared;app.innerHTML=`<main id="main" class="screen no-nav">${topBar(`${s.owner} 的饮食记录`,`${dateLabel(s.day)} · 分享内容`)}<section class="panel"><div class="stat-line"><span>当天摄入</span><strong>${round(total(s.meals,'calories'))} 千卡</strong></div><div class="stat-line"><span>记录的餐食</span><strong>${s.meals.length} 项</strong></div></section><div class="section-head"><h2>食物贴纸</h2></div>${stickerGrid(s.meals,state.shareToken)}<p class="privacy-copy">这是一份只读分享。链接可能随时由分享者撤销。</p><a class="button secondary full" href="./">打开轻食日记</a></main>`;
}
async function loadDay(){const [meals,water]=await Promise.all([api(`meals?day=${state.day}`),api(`water?day=${state.day}`)]);state.meals=meals.meals;state.water=water.amount;}
async function loadView(){
 await loadDay();
 if(state.view==='analysis')state.weekly=(await api(`meals?start=${shiftDay(state.day,-6)}&end=${state.day}`)).meals;
 if(state.view==='profile')state.weights=(await api('weights')).weights;
 render();
}
function addSheet(category){state.category=category||'breakfast';openSheet(`${sheetTop('记录一餐')}<p class="sheet-description">拍下眼前的食物，或直接填写你吃了什么。</p><button class="quick-option" data-action="camera"><span class="icon-wrap">${icon('camera')}</span><span><strong>拍照识别</strong><small>拍一张照片，生成食物贴纸</small></span></button><button class="quick-option" data-action="gallery"><span class="icon-wrap">${icon('image')}</span><span><strong>从相册选择</strong><small>上传已有的食物照片</small></span></button><button class="quick-option" data-action="manual"><span class="icon-wrap">${icon('plus')}</span><span><strong>手动记录</strong><small>自己填写食物和营养信息</small></span></button>`)}
function numberField(name,label,value='',required=false){return `<label class="field"><span>${label}</span><input name="${name}" type="number" min="0" max="100000" step="0.1" inputmode="decimal" placeholder="0" value="${esc(value)}" ${required?'required':''}></label>`}
function mealForm(meal=null,analysis=null){
 const editing=Boolean(meal);const estimate=analysis?.estimate||{};const candidates=analysis?.candidates||[];
 const name=meal?.name||estimate.name||candidates[0]?.name||'';const category=meal?.category||state.category;const image=analysis?.sticker||analysis?.photo;
 const imageMarkup=image?`<div class="preview"><img src="${image}" alt="生成的食物贴纸"></div>`:meal?.has_sticker||meal?.has_photo?`<div class="preview">${pic(meal)}</div>${meal.has_sticker?`<a class="text-button" href="api/meals/${meal.id}/sticker" download="food-sticker.png">保存透明贴纸</a>`:''}`:'';
 const notes=[];if(analysis?.recognition_error)notes.push(analysis.recognition_error);else if(analysis?.source==='local')notes.push('本地模型仅识别部分菜品，热量和营养请自行填写。');else if(analysis?.source)notes.push('AI 识别结果仅为估算，保存前请检查并修改。');if(analysis?.sticker_error)notes.push(analysis.sticker_error);
 openSheet(`${sheetTop(editing?'编辑饮食':'确认饮食记录')}${imageMarkup}${notes.length?`<p class="ai-note">${esc(notes.join(' '))}</p>`:''}${candidates.length?`<div class="candidates" aria-label="识别候选">${candidates.map((item,i)=>`<button class="candidate ${i===0?'active':''}" data-action="candidate" data-name="${esc(item.name)}">${esc(item.name)}</button>`).join('')}</div>`:''}
 <form id="meal-form" data-id="${editing?meal.id:''}"><label class="field"><span>食物名称</span><input name="name" maxlength="80" required placeholder="例如：番茄炒蛋" value="${esc(name)}"></label><div class="form-grid"><label class="field"><span>餐次</span><select name="category">${cats.map(([id,label])=>`<option value="${id}" ${category===id?'selected':''}>${label}</option>`).join('')}</select></label><label class="field"><span>日期</span><input type="date" name="day" value="${meal?.day||state.day}" required></label></div><div class="form-grid">${numberField('grams','重量 · 克',meal?.grams??estimate.grams??'')}${numberField('calories','热量 · 千卡',meal?.calories??estimate.calories??'',true)}</div><div class="form-grid three">${numberField('carbs','碳水 · 克',meal?.carbs??estimate.carbs??'')}${numberField('protein','蛋白质 · 克',meal?.protein??estimate.protein??'')}${numberField('fat','脂肪 · 克',meal?.fat??estimate.fat??'')}</div><p class="form-error" role="alert"></p><div class="sheet-footer">${editing?`<button class="button secondary danger" type="button" data-action="confirm-delete" data-id="${meal.id}">${icon('trash')}删除</button>`:''}<button class="button" type="submit">保存记录</button></div></form>`);
}
function settingsSheet(){const u=state.user;openSheet(`${sheetTop('目标与识别设置')}<form id="settings-form"><label class="field"><span>每日热量目标 · 千卡</span><input type="number" name="target" value="${u.target}" min="500" max="10000" required><small>可根据自己的情况随时调整。</small></label><label class="field"><span>照片识别服务</span><select name="provider"><option value="local" ${u.provider==='local'?'selected':''}>本地识别</option><option value="deepseek" ${u.provider==='deepseek'?'selected':''}>DeepSeek</option><option value="openai" ${u.provider==='openai'?'selected':''}>OpenAI</option></select></label><div id="provider-fields" ${u.provider==='local'?'hidden':''}><label class="field"><span>模型名称</span><input name="model" value="${esc(u.model)}" placeholder="输入支持图片的模型名称"><small>DeepSeek 默认 deepseek-flash；OpenAI 默认 gpt-4o-mini。</small></label><label class="field"><span>API 密钥</span><input name="api_key" type="password" autocomplete="off" placeholder="${u.has_key?'已配置；留空保持不变':'输入你的 API 密钥'}"><small>密钥加密保存在服务器，仅用于你选择的服务。更换服务时需要重新填写。识别照片会发送至所选服务商，并可能产生费用。</small></label><label><input type="checkbox" name="clear_key"> <span class="panel-note">清除当前保存的密钥</span></label></div><p class="form-error" role="alert"></p><div class="sheet-footer"><button class="button" type="submit">保存设置</button></div></form>`)}
function shareSheet(){const links=state.shares.map(s=>`<div class="share-item"><div>${esc(s.day)}<small>有效至 ${new Date(s.expires*1000).toLocaleDateString('zh-CN')}</small></div><button class="text-button" data-action="copy-share" data-token="${esc(s.token)}">复制</button><button class="text-button danger" data-action="revoke" data-id="${s.id}">撤销</button></div>`).join('');
 openSheet(`${sheetTop('分享管理')}<p class="sheet-description">链接可查看对应日期的餐食和贴纸，7 天后自动失效，也可随时撤销。</p><button class="button full" data-action="create-share">${icon('share')}生成 ${dateLabel(state.day)} 的分享链接</button><div style="margin-top:16px">${links||'<p class="panel-note">还没有有效的分享链接。</p>'}</div>`)}
function weightSheet(){openSheet(`${sheetTop('体重记录')}<form id="weight-form"><div class="form-grid"><label class="field"><span>日期</span><input type="date" name="day" value="${state.day}" required></label><label class="field"><span>体重 · 千克</span><input type="number" name="weight" min="10" max="500" step="0.1" required placeholder="例如 60.5"></label></div><p class="form-error" role="alert"></p><button class="button full" type="submit">保存体重</button></form><div style="margin-top:16px">${state.weights.map(w=>`<div class="stat-line"><span>${esc(w.day)}</span><strong>${w.weight} 千克</strong></div>`).join('')||'<p class="panel-note">还没有体重记录。</p>'}</div>`)}
async function preparePhoto(file){
 if(!file)return;const version=++state.scanVersion;openSheet(`${sheetTop('正在识别')}<div class="skeleton picture"></div><div class="skeleton line"></div><div class="skeleton line short"></div><p class="panel-note">正在生成贴纸和分析食物，通常需要一点时间。</p>`);
 try{
  const blob=await new Promise((resolve,reject)=>{const image=new Image();const url=URL.createObjectURL(file);image.onload=()=>{const canvas=document.createElement('canvas');const scale=Math.min(1,1280/Math.max(image.width,image.height));canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);canvas.toBlob(b=>b?resolve(b):reject(new Error('无法读取照片')),'image/jpeg',.88)};image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('无法读取照片，请换一张图片'))};image.src=url});
  const form=new FormData();form.append('image',blob,'food.jpg');const analysis=await api('analyze',{method:'POST',body:form});if(version!==state.scanVersion)return;state.image=analysis;mealForm(null,analysis);
 }catch(e){if(version!==state.scanVersion)return;openSheet(`${sheetTop('识别未完成')}<p class="sheet-description">${esc(e.message)}</p><button class="button full" data-action="manual">手动记录</button>`)}
}
async function copyShare(token){const url=new URL('./',location.href);url.searchParams.set('share',token);try{await navigator.clipboard.writeText(url.href);toast('分享链接已复制')}catch{openSheet(`${sheetTop('复制分享链接')}<p class="sheet-description">长按下方链接复制，发送给你的搭子。</p><label class="field"><span>分享链接</span><input value="${esc(url.href)}" readonly></label>`);$('input',sheet)?.select()}}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 const action=button.dataset.action;
 try{
  if(action==='close'){closeSheet();return}
  if(action==='auth-mode'){renderAuth(button.dataset.mode);return}
  if(action==='nav'){state.view=button.dataset.view;await loadView();return}
  if(action==='date'){state.day=button.dataset.day;await loadView();return}
  if(action==='layout'){state.layout=button.dataset.layout;render();return}
  if(action==='calendar'){openSheet(`${sheetTop('选择日期')}<form id="date-form"><label class="field"><span>查看哪一天</span><input type="date" name="day" value="${state.day}" required></label><button class="button full" type="submit">查看记录</button></form>`);return}
  if(action==='add'){state.image=null;addSheet(button.dataset.category);return}
  if(action==='manual'){state.image=null;mealForm();return}
  if(action==='camera'||action==='gallery'){$(`#${action}-input`).click();return}
  if(action==='candidate'){$('[name="name"]',sheet).value=button.dataset.name;sheet.querySelectorAll('.candidate').forEach(x=>x.classList.toggle('active',x===button));return}
  if(action==='edit'){const m=state.meals.find(x=>x.id===button.dataset.id);if(m){state.image=null;mealForm(m)}return}
  if(action==='confirm-delete'){const m=state.meals.find(x=>x.id===button.dataset.id);if(!m)return;openSheet(`${sheetTop('删除这条记录？')}<p class="sheet-description">删除后无法恢复「${esc(m.name)}」及对应的贴纸。</p><div class="two-buttons"><button class="button secondary" data-action="close">取消</button><button class="button" data-action="delete" data-id="${m.id}">确认删除</button></div>`);return}
  if(action==='delete'){await api(`meals/${button.dataset.id}`,{method:'DELETE'});closeSheet();await loadView();toast('已删除饮食记录');return}
  if(action==='settings'){settingsSheet();return}
  if(action==='weight'){weightSheet();return}
  if(action==='water'){const amount=Math.max(0,Math.min(10000,state.water+Number(button.dataset.amount)));state.water=(await api('water',{method:'PUT',body:{day:state.day,amount}})).amount;render();return}
  if(action==='share'||action==='manage-shares'){state.shares=(await api('shares')).shares;shareSheet();return}
  if(action==='create-share'){button.disabled=true;state.shares=(await api('shares',{method:'POST',body:{day:state.day}})).shares;const link=state.shares[0];shareSheet();await copyShare(link.token);return}
  if(action==='copy-share'){await copyShare(button.dataset.token);return}
  if(action==='revoke'){await api(`shares/${button.dataset.id}`,{method:'DELETE'});state.shares=(await api('shares')).shares;shareSheet();toast('分享链接已撤销');return}
  if(action==='delete-account'){openSheet(`${sheetTop('删除账号及数据')}<p class="sheet-description">此操作会永久删除账号、饮食照片、贴纸、体重、饮水和全部分享链接，无法恢复。</p><form id="delete-account-form"><label class="field"><span>输入密码以确认</span><input type="password" name="password" autocomplete="current-password" required></label><p class="form-error" role="alert"></p><div class="sheet-footer"><button class="button secondary" type="button" data-action="close">取消</button><button class="button" type="submit">永久删除</button></div></form>`);return}
  if(action==='logout'){await api('auth/logout',{method:'POST',body:{}});state.user=null;state.meals=[];render();return}
 }catch(e){button.disabled=false;toast(e.message)}
});

document.addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target;const values=Object.fromEntries(new FormData(form).entries());const submit=$('[type="submit"]',form);if(submit)submit.disabled=true;
 try{
  if(form.id==='auth-form'){
    const result=await api(`auth/${form.dataset.mode}`,{method:'POST',body:values});state.user=result.user;state.view='today';state.day=today();await loadView();return;
  }
  if(form.id==='delete-account-form'){await api('account',{method:'DELETE',body:values});state.user=null;state.meals=[];state.shares=[];closeSheet();render();toast('账号及数据已删除');return}
  if(form.id==='date-form'){state.day=values.day;closeSheet();await loadView();return}
  if(form.id==='meal-form'){
    const id=form.dataset.id;const payload={...values};if(!id&&state.image){payload.photo=state.image.photo;payload.sticker=state.image.sticker}
    await api(id?`meals/${id}`:'meals',{method:id?'PUT':'POST',body:payload});state.day=values.day;state.image=null;closeSheet();await loadView();toast(id?'记录已更新':'已保存饮食记录');return;
  }
  if(form.id==='settings-form'){
    values.clear_key=Boolean(values.clear_key);const result=await api('settings',{method:'PUT',body:values});state.user=result.user;closeSheet();render();toast('设置已保存');return;
  }
  if(form.id==='weight-form'){
    state.weights=(await api('weights',{method:'POST',body:values})).weights;weightSheet();render();toast('体重已记录');return;
  }
 }catch(e){formError(form,e.message)}finally{if(submit)submit.disabled=false}
});

document.addEventListener('change',event=>{
 if(event.target.matches('#camera-input,#gallery-input')){const file=event.target.files[0];event.target.value='';preparePhoto(file)}
 if(event.target.matches('#settings-form [name="provider"]')){
  const provider=event.target.value;$('#provider-fields',sheet).hidden=provider==='local';const model=$('[name="model"]',sheet);model.value=provider==='deepseek'?'deepseek-flash':provider==='openai'?'gpt-4o-mini':'';
 }
});

async function boot(){
 if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
 try{
  if(state.shareToken){try{state.shared=await api(`shared/${encodeURIComponent(state.shareToken)}`)}catch{state.shared=null}render();return}
  state.user=(await api('me')).user;if(state.user)await loadView();else render();
 }catch(e){app.innerHTML=`<main id="main" class="screen no-nav">${topBar('轻食日记')}<div class="no-records">${icon('lock')}<strong>暂时无法连接服务</strong><p>${esc(e.message)}</p></div><p><button class="button full" data-action="reload">重新加载</button></p></main>`;}
}
document.addEventListener('click',event=>{if(event.target.closest('[data-action="reload"]'))location.reload()});
boot();

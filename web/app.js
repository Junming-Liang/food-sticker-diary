'use strict';
const $ = (s, root=document) => root.querySelector(s);
const app = $('#app'), sheet = $('#sheet');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => localDate(new Date());
function localDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function localTime(d=new Date()){return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function categoryForTime(value){if(!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value||''))return null;const hour=Number(value.slice(0,2));return hour>=5&&hour<10?'breakfast':hour>=10&&hour<14?'lunch':hour>=17&&hour<21?'dinner':'snack'}
function validNoticeDay(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;const date=new Date(`${value}T12:00:00`);return !Number.isNaN(date.valueOf())&&localDate(date)===value}
function shiftDay(day, amount){const d=new Date(`${day}T12:00:00`);d.setDate(d.getDate()+amount);return localDate(d)}
function dateLabel(day){const d=new Date(`${day}T12:00:00`);return `${d.getMonth()+1}月${d.getDate()}日`}
const cats=[['breakfast','早餐','sun'],['lunch','午餐','spark'],['dinner','晚餐','sticker'],['snack','加餐','plus']];
const state={user:null,view:'today',day:today(),meals:[],exercises:[],water:0,layout:'list',category:'breakfast',categoryAuto:true,image:null,shares:[],weights:[],weekly:[],fasts:[],foods:[],foodRef:null,nutritionEdited:false,shareToken:new URL(location.href).searchParams.get('share'),shared:null,buddy:null,buddyToken:new URL(location.href).searchParams.get('invite'),scanVersion:0};
let toastTimer,scanPreviewUrl=null,foodLibraryDraft=null;
const initialParams=new URL(location.href).searchParams;
let pendingBuddyDay=initialParams.get('view')==='buddy'?(validNoticeDay(initialParams.get('day'))?initialParams.get('day'):today()):null;
const loaded={meals:null,water:null,exercises:null,weekly:null,weights:false,fasts:false,buddy:null};
let loadVersion=0, mutationVersion=0;
const pictureCache=new Map(),pictureRequests=new Map(),pictureObservers={};
let pictureBytes=0,pictureGeneration=0;
const supportsWebp=(()=>{try{return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')}catch{return false}})();

function clearPictureCache(){
 pictureGeneration++;
 for(const entry of pictureCache.values())URL.revokeObjectURL(entry.url);
 pictureCache.clear();pictureRequests.clear();pictureBytes=0;
}
function pictureFromCache(url){
 const entry=pictureCache.get(url);
 if(!entry)return null;
 if(Date.now()-entry.time>300000){pictureCache.delete(url);pictureBytes-=entry.size;URL.revokeObjectURL(entry.url);return null}
 pictureCache.delete(url);pictureCache.set(url,entry);return entry.url;
}
function getPicture(url){
 const cached=pictureFromCache(url);if(cached)return Promise.resolve(cached);
 if(pictureRequests.has(url))return pictureRequests.get(url);
 const generation=pictureGeneration;
 const pending=fetch(url,{credentials:'same-origin',cache:'no-cache'}).then(response=>{
  if(!response.ok)throw new Error('图片加载失败');return response.blob();
 }).then(blob=>{
  if(generation!==pictureGeneration)return null;
  const entry={url:URL.createObjectURL(blob),size:blob.size,time:Date.now()};
  pictureCache.set(url,entry);pictureBytes+=entry.size;
  while(pictureCache.size>48||pictureBytes>12*1024*1024){
   const oldest=pictureCache.keys().next().value,removed=pictureCache.get(oldest);
   pictureCache.delete(oldest);pictureBytes-=removed.size;URL.revokeObjectURL(removed.url);
  }
  return pictureCache.has(url)?entry.url:null;
 }).catch(()=>null).finally(()=>{if(pictureRequests.get(url)===pending)pictureRequests.delete(url)});
 pictureRequests.set(url,pending);return pending;
}
function hydratePictures(root){
 const key=root===app?'app':'sheet';pictureObservers[key]?.disconnect();
 const images=[...root.querySelectorAll('img[data-picture-src]')];
 function load(img){const source=img.dataset.pictureSrc;getPicture(source).then(url=>{if(!img.isConnected||img.dataset.pictureSrc!==source)return;if(url)img.src=url;else img.dispatchEvent(new Event('error'))})}
 if(!('IntersectionObserver' in window)){images.forEach(load);return}
 const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){observer.unobserve(entry.target);load(entry.target)}}),{rootMargin:'200px'});
 pictureObservers[key]=observer;images.forEach(img=>observer.observe(img));
}

function invalidate(path,method){
 mutationVersion++;
 if(path.startsWith('auth/')||path==='account'||(path.startsWith('meals/')&&(method==='DELETE'||path.endsWith('/sticker-style')))||
    (path.startsWith('buddy')&&(method==='DELETE'||path==='buddy/sharing'))||(path.startsWith('shares/')&&method==='DELETE'))clearPictureCache();
 if(path.startsWith('auth/'))Object.assign(loaded,{meals:null,water:null,exercises:null,weekly:null,weights:false,fasts:false,buddy:null});
 if(path.startsWith('meals')){loaded.meals=null;loaded.weekly=null}
 if(path.startsWith('water'))loaded.water=null;
 if(path.startsWith('exercises'))loaded.exercises=null;
 if(path.startsWith('weights'))loaded.weights=false;
 if(path.startsWith('fasts'))loaded.fasts=false;
 if(path.startsWith('buddy'))loaded.buddy=null;
}

async function api(path, opts={}){
  const init={method:opts.method||'GET', credentials:'same-origin', headers:{}};
  if(init.method!=='GET')invalidate(path,init.method);
  if(opts.body instanceof FormData) init.body=opts.body;
  else if(opts.body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body)}
  const res=await fetch(`api/${path}`,init);
  const data=await res.json().catch(()=>({error:'服务暂时不可用，请重试'}));
  if(!res.ok) throw new Error(data.error||'操作没有完成，请重试');
  return data;
}
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3200)}
function formError(form,message){const el=$(':scope > .form-error',form)||$('.form-error',form);if(el){el.textContent=message;el.classList.add('visible')}else toast(message)}
function openSheet(content){sheet.className='dialog';sheet.innerHTML=`<div class="sheet-inner">${content}</div>`;if(!sheet.open)sheet.showModal();hydratePictures(sheet)}
function closeSheet(){if(sheet.open)sheet.close();pictureObservers.sheet?.disconnect();if(scanPreviewUrl){URL.revokeObjectURL(scanPreviewUrl);scanPreviewUrl=null}state.scanVersion++}
function applyPendingBuddy(){
 if(!pendingBuddyDay)return;
 state.view='buddy';state.day=pendingBuddyDay;pendingBuddyDay=null;
 const url=new URL(location.href);url.searchParams.delete('view');url.searchParams.delete('day');history.replaceState(null,'',url.pathname+url.search+url.hash);
}
sheet.addEventListener('cancel',event=>{event.preventDefault();closeSheet()});
function sheetTop(title){return `<div class="sheet-top"><h2 id="sheet-title">${esc(title)}</h2><button class="icon-button" type="button" data-action="close" aria-label="关闭">${icon('close')}</button></div>`}
function round(n){return Math.round(Number(n)||0)}
function total(meals,key){return meals.reduce((sum,item)=>sum+Number(item[key]||0),0)}
function dayTitle(){return state.day===today()?`今天 · ${dateLabel(state.day)}`:dateLabel(state.day)}
function pic(meal,kind='sticker',token=null,size='thumbnail'){
  const wanted=kind==='sticker'&&meal.has_sticker?'sticker':(meal.has_photo?'photo':null);
  if(!wanted)return `<span class="empty-thumb">${icon('image')}</span>`;
  const url=token==='buddy'?`api/buddy/meals/${meal.id}/${wanted}`:token?`api/shared/${encodeURIComponent(token)}/image/${meal.id}/${wanted}`:`api/meals/${meal.id}/${wanted}`;
  const version=wanted==='sticker'?`&v=${meal.sticker_border||0}-${encodeURIComponent(meal.sticker_color||'#ffffff')}`:'';
  return `<img class="food-thumb" data-picture-src="${url}?size=${size}${supportsWebp?'&format=webp':''}${version}" alt="${esc(meal.name)}" decoding="async">`;
}
function nav(){return `<nav class="bottom-nav" aria-label="主要导航">
 ${[['today','home','记录'],['analysis','chart','分析'],['buddy','buddy','搭子'],['fasting','timer','断食'],['profile','user','我的']].map(([view,ico,label])=>{const active=state.view===view||(view==='today'&&state.view==='stickers');return `<button class="nav-item ${active?'active':''}" data-action="nav" data-view="${view}" ${active?'aria-current="page"':''}>${icon(ico)}<span>${label}</span></button>`}).join('')}
 <button class="nav-add" data-action="add" aria-label="添加饮食记录">${icon('plus')}</button></nav>`}
function topBar(title,sub='',actions=''){return `<header class="topbar"><div><h1 class="${title==='轻食日记'?'brand':'page-title'}">${title==='轻食日记'?'<span class="brand-mark"></span>':''}${esc(title)}</h1>${sub?`<div class="topbar-subtitle">${esc(sub)}</div>`:''}</div><div class="top-actions">${actions}</div></header>`}
function dateStrip(){
  const d=new Date(`${state.day}T12:00:00`);const weekday=d.getDay()||7;const monday=shiftDay(state.day,1-weekday);
  const labels=['一','二','三','四','五','六','日'];
  return `<div class="date-strip" aria-label="选择日期">${labels.map((w,i)=>{const date=shiftDay(monday,i);return `<button class="day ${state.day===date?'active':''} ${date===today()?'today':''}" data-action="date" data-day="${date}" aria-label="${date}" ${state.day===date?'aria-pressed="true"':''}><span class="day-label">${date===today()?'今天':`周${w}`}</span><span>${Number(date.slice(-2))}</span></button>`}).join('')}</div>`;
}
function ring(meals=state.meals,exercises=state.exercises,goal=state.user.target,buddy=false){
 const eaten=total(meals,'calories'), burned=total(exercises,'calories'), target=goal+burned, remain=Math.max(0,target-eaten), pct=Math.max(0,Math.min(1,eaten/target));
 return `<section class="summary" aria-label="${buddy?'搭子当天热量':'今日热量'}"><div class="summary-side"><strong>${round(eaten)}</strong><span>已摄入</span></div><div class="ring"><svg viewBox="0 0 164 164" aria-hidden="true"><circle class="ring-base" cx="82" cy="82" r="68" fill="none" stroke-width="8"/><circle class="ring-value" cx="82" cy="82" r="68" fill="none" stroke-width="8" stroke-dasharray="${(pct*427.3).toFixed(1)} 427.3"/></svg><div class="ring-center"><strong>${round(remain)}</strong><span>${eaten>target?`已超出 ${round(eaten-target)} 千卡`:buddy?'距目标还剩':'剩余可摄入'}</span>${buddy?'<span>未计运动消耗</span>':''}</div></div><div class="summary-side"><strong>${round(buddy?goal:burned)}</strong><span>${buddy?'每日目标':'运动消耗'}</span></div></section>`;
}
function macroGrid(meals=state.meals,goals=state.user){
 const values=[['碳水',total(meals,'carbs'),goals.carbs_goal,'var(--green)'],['蛋白质',total(meals,'protein'),goals.protein_goal,'var(--purple)'],['脂肪',total(meals,'fat'),goals.fat_goal,'var(--yellow)']];
 return `<section class="macro-grid" aria-label="营养记录">${values.map(([name,value,goal,color])=>`<div class="macro"><div class="macro-label"><span>${name}</span></div><strong class="macro-value">${Math.round(value*10)/10}<small>${goal?` / ${Math.round(goal*10)/10} g`:' g'}</small></strong><div class="track"><span style="--color:${color};width:${goal?Math.min(100,Math.round(value/goal*100)):0}%"></span></div></div>`).join('')}</section>`;
}
function mealTargets(goal,split){
 if(!split)return null;
 const parts=cats.map(([id],index)=>{const exact=goal*split[id]/100;return {id,index,value:Math.floor(exact),fraction:exact-Math.floor(exact)}});
 const remainder=goal-parts.reduce((sum,item)=>sum+item.value,0);
 [...parts].sort((a,b)=>b.fraction-a.fraction||a.index-b.index).slice(0,remainder).forEach(item=>item.value++);
 return Object.fromEntries(parts.map(item=>[item.id,item.value]));
}
function mealGroups(meals=state.meals,token=null,split=state.user.meal_split,goal=state.user.target){const targets=mealTargets(goal,split);return `<div class="meals">${cats.map(([id,label,ico])=>{
 const items=meals.filter(x=>x.category===id),sum=total(items,'calories');
 return `<section class="meal-group"><div class="meal-group-header"><div class="meal-title"><div class="meal-glyph">${icon(ico==='sun'?'spark':ico)}</div><div><strong>${label}</strong><small ${targets?`aria-label="已摄入 ${round(sum)} 千卡，目标 ${targets[id]} 千卡"`:''}>${round(sum)}${targets?` / ${targets[id]}`:''} 千卡</small></div></div>${token?'':`<button class="add-mini" data-action="add" data-category="${id}" aria-label="添加${label}">${icon('plus')}</button>`}</div>
 ${items.length?`<div class="meal-entries">${items.map(m=>`<button class="meal-row" data-action="${token?'view-shared-meal':'edit'}" data-id="${m.id}">${pic(m,'sticker',token,'small')}<span class="food-info"><strong>${esc(m.name)}</strong><small>${m.record_time?`${esc(m.record_time)} · `:''}${m.grams?`${round(m.grams)} 克`:'重量未填写'}</small></span><span class="food-cal">${round(m.calories)} 千卡</span></button>`).join('')}</div>`:`<p class="empty-group">还没有${label}记录</p>`}</section>`}).join('')}</div>`}
function stickerGrid(meals,token=null,poster=false){if(!meals.length)return `<div class="no-records">${icon('sticker')}<strong>还没有食物贴纸</strong><p>${token?'这一天还没有饮食记录':'拍下你的下一餐，留下一张食物贴纸'}</p></div>`;
 return `<div class="sticker-grid">${meals.map(m=>`<div class="sticker-card"><button data-action="${token?'view-shared-meal':'edit'}" data-id="${m.id}">${poster?`<span class="poster-meal-type">${esc(cats.find(([id])=>id===m.category)?.[1]||'餐食')}${m.record_time?` · ${esc(m.record_time)}`:''}</span>`:''}${pic(m,'sticker',token)}<strong>${esc(m.name)}</strong><small>${round(m.calories)} 千卡</small>${!poster&&m.record_time?`<small>${esc(m.record_time)}</small>`:''}${!poster&&m.components?.length?`<small>${esc(m.components.map(item=>item.name).join(' · '))}</small>`:''}</button>${!token&&m.has_sticker?`<button class="edit-sticker" data-action="edit-sticker" data-id="${m.id}" aria-label="编辑 ${esc(m.name)} 的贴纸">编辑贴纸</button>`:''}</div>`).join('')}</div>`}
function exercisePanel(){const burned=total(state.exercises,'calories');return `<div class="section-head" style="margin-top:24px"><h2>运动记录</h2><button class="text-button" data-action="add-exercise">添加运动</button></div><section class="meal-group"><div class="meal-group-header"><div class="meal-title"><div class="meal-glyph">${icon('activity')}</div><div><strong>运动消耗</strong><small>${round(burned)} 千卡</small></div></div><button class="add-mini" data-action="add-exercise" aria-label="添加运动">${icon('plus')}</button></div>${state.exercises.length?`<div class="meal-entries">${state.exercises.map(e=>`<button class="meal-row" data-action="edit-exercise" data-id="${e.id}"><span class="empty-thumb">${icon('activity')}</span><span class="food-info"><strong>${esc(e.name)}</strong><small>${e.minutes} 分钟</small></span><span class="food-cal">${round(e.calories)} 千卡</span></button>`).join('')}</div>`:'<p class="empty-group">还没有运动记录</p>'}</section>`}
function todayView(){const calendar=`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('calendar')}</button>`;
 return `${topBar('轻食日记',dayTitle(),calendar)}${dateStrip()}${ring()}${macroGrid()}<div class="section-head"><h2>饮食记录</h2><div class="record-actions"><button class="text-button" data-action="nav" data-view="stickers">贴纸墙</button><div class="segmented" aria-label="记录显示方式"><button class="${state.layout==='list'?'active':''}" data-action="layout" data-layout="list" aria-label="列表" aria-pressed="${state.layout==='list'}">${icon('list')}</button><button class="${state.layout==='grid'?'active':''}" data-action="layout" data-layout="grid" aria-label="贴纸" aria-pressed="${state.layout==='grid'}">${icon('grid')}</button></div></div></div>${state.layout==='list'?`${state.user.meal_split?'<p class="meal-target-note">餐次目标按当前每日目标分配，不含运动消耗</p>':''}${mealGroups()}`:stickerGrid(state.meals)}${exercisePanel()}`}
function weightChart(){
 const entries=state.weights.filter(item=>item.day<=state.day).slice(0,14).reverse();
 if(!entries.length)return `<section class="panel"><div class="panel-top"><div><h2>体重趋势</h2><p class="panel-note">记录体重后可在这里回看</p></div><button class="text-button" data-action="weight">记录体重</button></div></section>`;
 const latest=entries[entries.length-1];
 if(entries.length===1)return `<section class="panel"><div class="panel-top"><div><h2>体重趋势</h2><p class="panel-note">${esc(latest.day)} · ${latest.weight} 千克</p></div><button class="text-button" data-action="weight">记录体重</button></div><p class="panel-note">再记录一次，即可查看变化。</p></section>`;
 const weights=entries.map(item=>Number(item.weight)),minimum=Math.min(...weights),maximum=Math.max(...weights),padding=Math.max(.5,(maximum-minimum)*.1),lo=minimum-padding,hi=maximum+padding;
 const points=entries.map((item,index)=>({x:16+index*288/(entries.length-1),y:14+(hi-Number(item.weight))*92/(hi-lo),weight:item.weight,day:item.day}));
 const path=points.map((p,index)=>`${index?'L':'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
 return `<section class="panel"><div class="panel-top"><div><h2>体重趋势</h2><p class="panel-note">最近 ${entries.length} 次 · 当前 ${latest.weight} 千克 · 范围 ${minimum} 至 ${maximum} 千克</p></div><button class="text-button" data-action="weight">记录体重</button></div><svg class="weight-chart" viewBox="0 0 320 120" role="img" aria-label="体重记录变化"><path d="${path}" fill="none" stroke="#f33e22" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#f33e22"/>`).join('')}</svg><div class="chart-dates"><span>${esc(entries[0].day)}</span><span>${esc(latest.day)}</span></div></section>`;
}
function analysisView(){
 const days=Array.from({length:7},(_,i)=>shiftDay(state.day,i-6));const amounts=days.map(day=>total(state.weekly.filter(m=>m.day===day),'calories'));const max=Math.max(state.user.target,...amounts,1);
 return `${topBar('分析','看看最近的饮食节奏',`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('calendar')}</button>`)}<section class="panel"><div class="panel-top"><div><h2>热量摄入</h2><p class="panel-note">${dateLabel(days[0])} 至 ${dateLabel(days[6])}</p></div>${icon('chart')}</div><div class="bars" aria-label="最近七天热量摄入">${days.map((day,i)=>`<div class="bar-column"><span class="bar-value">${amounts[i]?round(amounts[i]):''}</span><span class="bar ${amounts[i]?'':'empty'}" style="height:${Math.max(2,Math.round(amounts[i]/max*105))}px"></span><span class="bar-label">${day.slice(-2)}日</span></div>`).join('')}</div></section><section class="panel"><h2>这一天</h2><div class="stat-line"><span>摄入热量</span><strong>${round(total(state.meals,'calories'))} 千卡</strong></div><div class="stat-line"><span>记录餐食</span><strong>${state.meals.length} 项</strong></div><div class="stat-line"><span>运动消耗</span><strong>${round(total(state.exercises,'calories'))} 千卡</strong></div><div class="stat-line"><span>饮水</span><strong>${state.water} 毫升</strong></div></section>${weightChart()}<p class="privacy-copy">营养数值为估算，可能因食材、份量和烹饪方式而不同。请结合实际情况调整。</p>`;
}
function stickersView(){return `${topBar('食物贴纸',dayTitle(),`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('calendar')}</button><button class="icon-button" data-action="nav" data-view="today" aria-label="返回记录">${icon('back')}</button>`)}${dateStrip()}<div class="share-banner"><h2>把今天的饮食分享给搭子</h2><p>对方可以查看当天的餐食、记录时间和贴纸，原照片不会分享。自动抠图可能保留部分背景，请先查看贴纸。</p><button class="button" data-action="share">${icon('share')}分享这一天</button><button class="text-button" data-action="buddy">查看我的搭子</button></div>${stickerGrid(state.meals)}`}
function duration(seconds){const s=Math.max(0,Math.floor(seconds)),h=String(Math.floor(s/3600)).padStart(2,'0'),m=String(Math.floor(s%3600/60)).padStart(2,'0'),sec=String(s%60).padStart(2,'0');return `${h}:${m}:${sec}`}
function fastingView(){
 const active=state.fasts.find(f=>!f.ended);const elapsed=active?Math.max(0,Date.now()/1000-active.started):0;const ratio=active?Math.min(1,elapsed/(active.goal_hours*3600)):0;
 const history=state.fasts.filter(f=>f.ended);
 return `${topBar('轻断食','记录属于自己的节奏')}<section class="fasting-main"><span class="fasting-label">${active?`正在计时 · 目标 ${active.goal_hours} 小时`:'选择时长，准备好再开始'}</span><div class="ring fasting-ring"><svg viewBox="0 0 164 164" aria-hidden="true"><circle class="ring-base" cx="82" cy="82" r="68" fill="none" stroke-width="8"/><circle class="ring-value" id="fast-ring" cx="82" cy="82" r="68" fill="none" stroke-width="8" stroke-dasharray="${(ratio*427.3).toFixed(1)} 427.3"/></svg><div class="ring-center"><span>${active?'已进行':'还未开始'}</span><strong id="fast-clock" ${active?`data-started="${active.started}" data-goal="${active.goal_hours}"`:''}>${duration(elapsed)}</strong><span>${active?`开始于 ${new Date(active.started*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:'按照自己的节奏记录'}</span></div></div>${active?`<button class="button outline full" data-action="confirm-end-fast">结束本次计时</button>`:`<label class="field"><span>本次计时目标</span><select id="fast-goal"><option value="12">12 小时</option><option value="14">14 小时</option><option value="16" selected>16 小时</option><option value="18">18 小时</option></select></label><button class="button full" data-action="start-fast">开始计时</button>`}</section><div class="section-head"><h2>历史记录</h2></div>${history.length?`<section class="panel">${history.map(f=>`<div class="share-item"><div>${new Date(f.started*1000).toLocaleDateString('zh-CN')}<small>目标 ${f.goal_hours} 小时 · 实际 ${duration(f.ended-f.started)}</small></div><button class="text-button danger" data-action="confirm-delete-fast" data-id="${f.id}">删除</button></div>`).join('')}</section>`:`<div class="no-records">${icon('timer')}<strong>还没有计时记录</strong><p>结束一次计时后，可以在这里回看</p></div>`}<p class="privacy-copy">计时仅供日常记录，请根据自身情况选择，不构成医疗建议。</p>`;
}
function buddyView(){
 const b=state.buddy;
 const back=`<button class="icon-button" data-action="calendar" aria-label="选择日期">${icon('calendar')}</button>`;
 if(!b?.paired)return `${topBar('我的搭子','和朋友一起记录',back)}<section class="share-banner"><h2>一起记录，互相陪伴</h2><p>发送邀请并由对方确认后，你们可以互看每日热量、餐食的记录时间与食物贴纸。双方可分别暂停共享或解除绑定。</p><button class="button" data-action="invite-buddy">${icon('share')}邀请搭子</button></section><div class="no-records">${icon('user')}<strong>还没有绑定搭子</strong><p>邀请链接 24 小时内有效，每个人同时只能绑定一位搭子</p></div>`;
 return `${topBar('我的搭子',dateLabel(state.day),back)}${dateStrip()}<section class="buddy-identity"><div class="avatar">${esc(b.username.slice(0,1).toUpperCase())}</div><div class="buddy-identity-text"><strong>${esc(b.username)}</strong><small>${b.sharing?'你正在向对方共享':'你已暂停向对方共享'}</small></div><button class="text-button" data-action="buddy-settings">共享设置</button></section>${b.other_sharing?`${ring(b.meals,[],b.target,true)}${macroGrid(b.meals,{})}<div class="section-head"><h2>饮食记录</h2><span class="section-sub">对方的记录 · 只读</span></div>${b.meal_split?'<p class="meal-target-note">餐次目标按对方当前每日目标分配</p>':''}${mealGroups(b.meals,'buddy',b.meal_split,b.target)}`:`<div class="no-records">${icon('lock')}<strong>对方已暂停共享</strong><p>恢复共享后可以继续查看</p></div>`}`;
}
function profileView(){const username=esc(state.user.username);return `${topBar('我的')}<div class="account"><div class="avatar">${esc(state.user.username.slice(0,1).toUpperCase())}</div><div><strong>${username}</strong><small>记录每一餐，照顾好自己</small></div></div><section class="panel"><div class="panel-top"><div><h2>今天喝水了吗</h2><p class="panel-note">每次增减 250 毫升</p></div>${icon('drop')}</div><div class="water-line"><div class="water-count"><strong>${state.water}</strong> <span>毫升</span></div><div class="stepper"><button data-action="water" data-amount="-250" aria-label="减少饮水">−</button><button data-action="water" data-amount="250" aria-label="增加饮水">+</button></div></div></section><div class="setting-list"><button class="setting-row" data-action="settings">${icon('spark')}<span>热量目标与识别设置<small>每日 ${state.user.target} 千卡 · ${state.user.provider==='local'?'本地识别':esc(state.user.provider)}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="meal-split">${icon('chart')}<span>餐次热量分配<small>${state.user.meal_split?'已设置四餐比例':'按比例分配每日目标'}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="weight">${icon('weight')}<span>体重记录<small>${state.weights.length?`${state.weights[0].weight} 千克 · ${state.weights[0].day}`:'记录今天的体重'}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="buddy">${icon('user')}<span>我的搭子<small>互看每日热量和食物贴纸</small></span>${icon('chevron')}</button><button class="setting-row" data-action="push-settings">${icon('bell')}<span>搭子更新提醒<small>搭子记录新餐食时通知本机</small></span>${icon('chevron')}</button><button class="setting-row" data-action="manage-shares">${icon('share')}<span>分享管理<small>查看或撤销分享链接</small></span>${icon('chevron')}</button></div><button class="button outline full" data-action="logout">退出登录</button><button class="text-button danger" data-action="delete-account" style="display:block;margin:10px auto 0">删除账号及数据</button><p class="privacy-copy">饮食数据默认仅自己可见。搭子共享开启或主动创建分享链接后，对方可查看对应餐食、记录时间和贴纸。识别结果仅供日常参考。</p>`}
function render(){
 if(state.shareToken){renderShared();hydratePictures(app);return}
 if(!state.user){renderAuth();return}
 const content=state.view==='today'?todayView():state.view==='analysis'?analysisView():state.view==='stickers'?stickersView():state.view==='buddy'?buddyView():state.view==='fasting'?fastingView():profileView();
 app.innerHTML=`<main id="main" class="screen">${content}</main>${nav()}`;
 hydratePictures(app);
}
function renderAuth(mode='login'){
 const registering=mode==='register';
 app.innerHTML=`<main id="main" class="auth-screen"><img class="auth-logo" src="icon-192.png" alt=""><h1>把每一餐，<br>轻轻记下来。</h1><p class="intro">拍照记录饮食，留下食物贴纸。<br>从今天开始，更了解自己的每一餐。</p>${state.buddyToken?'<p class="panel-note">登录后可查看搭子邀请，并决定是否共享。</p>':''}<form id="auth-form" data-mode="${mode}"><label class="field"><span>用户名</span><input name="username" autocomplete="username" required minlength="2" maxlength="32" placeholder="输入用户名"></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="${registering?'new-password':'current-password'}" minlength="8" maxlength="128" required placeholder="至少 8 位"></label><p class="form-error" role="alert"></p><button class="button full" type="submit">${registering?'创建账号':'登录'}</button></form><p class="auth-switch">${registering?'已经有账号？':'还没有账号？'}<button data-action="auth-mode" data-mode="${registering?'login':'register'}">${registering?'直接登录':'创建账号'}</button></p><p class="auth-foot">数据默认仅自己可见，分享由你决定。<br>食物热量与营养为估算值，请按实际情况调整。</p></main>`;
 hydratePictures(app);
}
function renderShared(){
 if(!state.shared){app.innerHTML=`<main id="main" class="share-page"><article class="share-poster"><div class="poster-brand"><img src="icon-192.png" alt=""><strong>轻食日记</strong></div><div class="poster-unavailable">${icon('lock')}<h1>分享链接无效或已过期</h1><p>请联系分享者重新发送链接</p></div><a class="button full" href="./">打开轻食日记</a></article></main>`;return}
 const s=state.shared,weekday=['日','一','二','三','四','五','六'][new Date(`${s.day}T12:00:00`).getDay()];
 const macros=[['碳水','carbs'],['蛋白质','protein'],['脂肪','fat']];
 app.innerHTML=`<main id="main" class="share-page"><article class="share-poster"><header class="poster-brand"><img src="icon-192.png" alt=""><strong>轻食日记</strong><span>把每一餐，轻轻记下来</span></header><div class="poster-intro"><h1>${esc(s.owner)} 的饮食记录</h1><p>${esc(dateLabel(s.day))} · 星期${weekday}</p></div><section class="poster-summary" aria-label="当天营养汇总"><div class="poster-total"><span>当天摄入</span><strong>${round(total(s.meals,'calories'))} <small>千卡</small></strong></div><div class="poster-macros">${macros.map(([label,key])=>`<div><span>${label}</span><strong>${Math.round(total(s.meals,key)*10)/10} <small>g</small></strong></div>`).join('')}</div></section><div class="poster-section-head"><h2>食物贴纸</h2><span>${s.meals.length} 项记录</span></div>${stickerGrid(s.meals,state.shareToken,true)}<footer class="poster-footer"><div class="poster-promo"><div><strong>把每一餐，轻轻记下来。</strong><p>拍照识别 · 饮食记录 · 食物贴纸</p><span class="poster-qr-caption" hidden>扫描打开轻食日记</span></div><div class="poster-qr" hidden></div></div><p class="poster-privacy">这是一份只读分享，链接可能随时由分享者撤销。</p></footer></article><a class="button full poster-open" href="./">打开轻食日记 ${icon('chevron')}</a></main>`;
 const qrContainer=$('.poster-qr',app),homeUrl=new URL('./',location.href).href;
 import('./vendor/qrcode.mjs').then(({default:qrcode})=>{if(!qrContainer.isConnected)return;const qr=qrcode(0,'M');qr.addData(homeUrl);qr.make();qrContainer.innerHTML=qr.createSvgTag({cellSize:4,margin:16,scalable:true,title:'扫描打开轻食日记'});qrContainer.hidden=false;$('.poster-qr-caption',app).hidden=false}).catch(()=>{});
}
function viewReady(view,day){
 const dayReady=loaded.meals===day&&loaded.water===day&&loaded.exercises===day;
 if(view==='today')return dayReady;
 if(view==='analysis')return dayReady&&loaded.weekly===day&&loaded.weights;
 if(view==='stickers')return loaded.meals===day;
 if(view==='profile')return loaded.water===day&&loaded.weights;
 if(view==='buddy')return loaded.buddy===day;
 return loaded.fasts;
}
function renderViewLoading(view,error=false){
 const titles={today:'轻食日记',analysis:'分析',stickers:'食物贴纸',fasting:'轻断食',profile:'我的',buddy:'我的搭子'};
 app.innerHTML=`<main id="main" class="screen">${topBar(titles[view])}<div class="loading-page" role="status">${error?'<p>暂时无法加载，请重试。</p><button class="button secondary" data-action="retry-view">重新加载</button>':'<span class="loading-line"></span><span class="loading-line short"></span><p class="panel-note">正在加载…</p>'}</div></main>${nav()}`;
 hydratePictures(app);
}
async function loadView({instant=false}={}){
 const view=state.view,day=state.day,user=state.user,version=++loadVersion,mutation=mutationVersion;
 const current=()=>version===loadVersion&&state.user===user&&state.view===view&&state.day===day&&mutation===mutationVersion;
 const renderedCached=instant&&viewReady(view,day);
 if(instant){if(renderedCached)render();else renderViewLoading(view)}
 const jobs=[];
 const add=(key,path,field,marker)=>jobs.push(api(path).then(result=>({key,value:field?result[field]:result,marker})));
 if(view==='today'||view==='analysis'||view==='stickers')add('meals',`meals?day=${day}`,'meals',day);
 if(view==='today'||view==='analysis'||view==='profile')add('water',`water?day=${day}`,'amount',day);
 if(view==='today'||view==='analysis')add('exercises',`exercises?day=${day}`,'exercises',day);
 if(view==='analysis')add('weekly',`meals?start=${shiftDay(day,-6)}&end=${day}`,'meals',day);
 if(view==='profile'||view==='analysis')add('weights','weights','weights',true);
 if(view==='buddy')add('buddy',`buddy?day=${day}`,null,day);
 if(view==='fasting')add('fasts','fasts','fasts',true);
 try{
  const results=await Promise.all(jobs);
  if(!current())return;
  const changed=results.some(({key,value})=>JSON.stringify(state[key])!==JSON.stringify(value));
  for(const {key,value,marker} of results){state[key]=value;loaded[key]=marker}
  if(!renderedCached||changed)render();
 }catch(error){if(!current())return;if(instant&&!viewReady(view,day))renderViewLoading(view,true);throw error}
}
function addSheet(category){state.category=category||categoryForTime(localTime());state.categoryAuto=!category;openSheet(`${sheetTop('记录一餐')}<p class="sheet-description">拍下眼前的食物，或直接填写你吃了什么。</p><button class="quick-option" data-action="camera"><span class="icon-wrap">${icon('camera')}</span><span><strong>拍照识别</strong><small>拍一张照片，生成食物贴纸</small></span></button><button class="quick-option" data-action="gallery"><span class="icon-wrap">${icon('image')}</span><span><strong>从相册选择</strong><small>上传已有的食物照片</small></span></button><button class="quick-option" data-action="food-library"><span class="icon-wrap">${icon('list')}</span><span><strong>食物库</strong><small>搜索常见食材，按重量估算营养</small></span></button><button class="quick-option" data-action="manual"><span class="icon-wrap">${icon('plus')}</span><span><strong>手动记录</strong><small>自己填写食物和营养信息</small></span></button>`)}
function numberField(name,label,value='',required=false){return `<label class="field"><span>${label}</span><input name="${name}" type="number" min="0" max="100000" step="0.1" inputmode="decimal" placeholder="0" value="${esc(value)}" ${required?'required':''}></label>`}
function componentMarkup(item={}){
 const num=(key,label,required=false)=>`<label class="field"><span>${label}</span><input data-component-field="${key}" type="number" min="0" max="100000" step="0.1" inputmode="decimal" placeholder="0" value="${esc(item[key]??'')}" ${required?'required':''}></label>`;
 return `<section class="food-component"><div class="component-head"><strong>食物明细</strong><button type="button" class="text-button danger" data-action="remove-component">移除</button></div><label class="field"><span>名称</span><input data-component-field="name" maxlength="80" required value="${esc(item.name||'')}" placeholder="例如：鸡蛋"></label><div class="form-grid">${num('grams','重量 · 克')}${num('calories','热量 · 千卡',true)}</div><div class="form-grid three">${num('carbs','碳水 · 克')}${num('protein','蛋白质 · 克')}${num('fat','脂肪 · 克')}</div></section>`;
}
function updateComponentTotals(form){
 const items=[...form.querySelectorAll('.food-component')];
 for(const key of ['grams','calories','carbs','protein','fat']){
  const field=$(`[name="${key}"]`,form);field.readOnly=items.length>0&&key!=='grams';
  if(items.length){const sum=items.reduce((n,item)=>n+(Number($(`[data-component-field="${key}"]`,item).value)||0),0);field.value=String(Math.round(sum*10)/10)}
 }
 const note=$('#nutrition-note',form);if(note&&items.length)note.textContent='总量由各项食物相加；调整总重量会按比例换算各项，也可单独修改。';
 else if(note&&!state.foodRef)note.textContent='未填写的重量与营养项按 0 记录，可随时修改。';
}
const nutritionBases=new WeakMap(),totalWeightBases=new WeakMap(),nutrients=['calories','carbs','protein','fat'];
function nutritionInput(group,key){return group.classList.contains('food-component')?$(`[data-component-field="${key}"]`,group):$(`[name="${key}"]`,group)}
function setNutritionBase(group,key){
 const weight=nutritionInput(group,'grams'),input=nutritionInput(group,key),grams=Number(weight.value),value=Number(input.value);
 const bases=nutritionBases.get(group)||{};nutritionBases.set(group,bases);
 if(weight.value!==''&&grams>0&&input.value!==''&&Number.isFinite(value)&&value>=0)bases[key]={grams,value};
 else delete bases[key];
}
function initializeNutrition(group){for(const key of nutrients)setNutritionBase(group,key)}
function scaleNutrition(group){
 const weight=nutritionInput(group,'grams'),grams=Number(weight.value),bases=nutritionBases.get(group)||{};
 if(weight.value===''||!Number.isFinite(grams)||grams<0)return;
 for(const key of nutrients){
  const input=nutritionInput(group,key),base=bases[key];
  if(base)input.value=String(Math.round(base.value*grams/base.grams*10)/10);
  else if(grams>0&&input.value!=='')setNutritionBase(group,key);
 }
}
function initializeTotalWeight(form){
 const items=[...form.querySelectorAll('.food-component')].map(group=>({group,grams:Number(nutritionInput(group,'grams').value)||0}));
 totalWeightBases.set(form,{items,grams:items.reduce((sum,item)=>sum+item.grams,0)});
}
function scaleComponents(form){
 const field=$('[name="grams"]',form),grams=Number(field.value),base=totalWeightBases.get(form);
 if(field.value===''||!Number.isFinite(grams)||grams<0||!base||base.grams<=0)return;
 for(const item of base.items){nutritionInput(item.group,'grams').value=String(Math.round(item.grams*grams/base.grams*10)/10);scaleNutrition(item.group)}
 updateComponentTotals(form);
}
function mealForm(meal=null,analysis=null,draft={}){
 const editing=Boolean(meal);const estimate=analysis?.estimate||{};const candidates=analysis?.candidates||[];const components=meal?.components||estimate.components||[];
 const name=meal?.name||estimate.name||candidates[0]?.name||'';const day=meal?.day||draft.day||state.day;const image=analysis?.sticker||analysis?.photo;
 const timeAuto=draft.timeAuto??!editing;const recordTime=editing?(meal.record_time??''):(draft.record_time??(day===today()?localTime():''));
 const categoryAuto=!editing&&(draft.categoryAuto??state.categoryAuto);const category=meal?.category||draft.category||(categoryAuto&&categoryForTime(recordTime))||state.category;
 const alternatives=Array.isArray(estimate.alternatives)?estimate.alternatives:[];
 const visionChoices=alternatives.length?[estimate.name,...alternatives].filter(Boolean):[];
 const canRetry=!editing&&analysis?.photo&&['deepseek','openai'].includes(state.user?.provider);
 const imageMarkup=image?`<div class="preview"><img src="${image}" alt="生成的食物贴纸"></div>`:meal?.has_sticker||meal?.has_photo?`<div class="preview">${pic(meal)}</div>${meal.has_sticker?`<a class="text-button" href="api/meals/${meal.id}/sticker" download="food-sticker.png">保存透明贴纸</a>`:''}`:'';
 const notes=[];if(analysis?.recognition_error)notes.push(analysis.recognition_error);else if(analysis?.source==='local'&&analysis?.local_reference)notes.push('已按识别候选匹配每 100 克的参考数据；照片无法确定份量，请核对食物、重量及做法。');else if(analysis?.source==='local')notes.push('本地模型仅识别部分菜品，可从食物库选择食材或自行填写营养。');else if(analysis?.source==='catalog')notes.push('已按 100 克及 USDA 食物数据估算，可按实际重量和做法修改。');else if(analysis?.source)notes.push('AI 识别结果仅为估算，保存前请检查并修改。');if(estimate.uncertainty_note)notes.push(estimate.uncertainty_note);if(analysis?.sticker_error)notes.push(analysis.sticker_error);
 openSheet(`${sheetTop(editing?'编辑饮食':'确认饮食记录')}${imageMarkup}${notes.length?`<p class="ai-note">${esc(notes.join(' '))}</p>`:''}${candidates.length?`<div class="candidates" aria-label="识别候选">${candidates.map((item,i)=>`<button class="candidate ${i===0?'active':''}" data-action="candidate" data-name="${esc(item.name)}">${esc(item.name)}</button>`).join('')}</div>`:''}${visionChoices.length?`<p class="field-label">也可能是</p><div class="candidates" aria-label="可能的菜品">${visionChoices.map((item,i)=>`<button class="candidate ${i===0?'active':''}" type="button" data-action="vision-candidate" data-name="${esc(item)}">${esc(item)}</button>`).join('')}</div><p id="vision-choice-note" class="ai-note" role="status" hidden></p>`:''}
 <form id="meal-form" data-id="${editing?meal.id:''}" data-time-auto="${timeAuto?'1':'0'}" data-category-auto="${categoryAuto?'1':'0'}"><label class="field"><span>食物名称</span><input name="name" maxlength="80" required placeholder="例如：番茄炒蛋" value="${esc(name)}"></label>${canRetry?`<details class="recognition-correction"><summary>识别不准？补充菜名或配料</summary><label class="field"><span>食物说明</span><input id="recognition-hint" maxlength="120" placeholder="例如：螺蛳粉，有酸笋和腐竹"></label><p class="panel-note">说明和照片会发送至所选服务；重新识别会替换当前名称和营养估算，可能产生 API 费用。</p><p id="recognition-retry-error" class="form-error" role="alert"></p><button class="button secondary full" type="button" data-action="retry-recognition">根据说明重新识别</button></details>`:''}${!editing&&!components.length?'<button class="text-button" type="button" data-action="food-library">从食物库选择</button>':''}<div class="form-grid"><label class="field"><span>餐次</span><select name="category">${cats.map(([id,label])=>`<option value="${id}" ${category===id?'selected':''}>${label}</option>`).join('')}</select></label><label class="field"><span>日期</span><input type="date" name="day" value="${esc(day)}" required></label></div><label class="field"><span>记录时间（可选）</span><input type="time" name="record_time" value="${esc(recordTime)}"><small>按当地时间保存，填写后会随餐食共享。${categoryAuto?'餐次会按时间选择，可自行修改。':''}</small></label><div class="component-section"><div class="component-head"><strong>食物明细</strong><button class="text-button" type="button" data-action="add-component">添加食物</button></div><div id="component-list">${components.map(componentMarkup).join('')}</div></div><div class="form-grid">${numberField('grams','总重量 · 克',meal?.grams??estimate.grams??'')}${numberField('calories','总热量 · 千卡',meal?.calories??estimate.calories??'',true)}</div><div class="form-grid three">${numberField('carbs','碳水 · 克',meal?.carbs??estimate.carbs??'')}${numberField('protein','蛋白质 · 克',meal?.protein??estimate.protein??'')}${numberField('fat','脂肪 · 克',meal?.fat??estimate.fat??'')}</div><p class="ai-note" id="nutrition-note">${state.foodRef?`数据来源：USDA FoodData Central · <a href="https://fdc.nal.usda.gov/food-details/${state.foodRef.id}/nutrients" target="_blank" rel="noopener noreferrer">查看食物原始数据</a>。修改重量时会重新估算。`:'未填写的重量与营养项按 0 记录，可随时修改。'}</p><p class="form-error" role="alert"></p><div class="sheet-footer">${editing?`<button class="button secondary danger" type="button" data-action="confirm-delete" data-id="${meal.id}">${icon('trash')}删除</button>`:''}<button class="button" type="submit">保存记录</button></div></form>`);
 const form=$('#meal-form',sheet);initializeNutrition(form);
 form.querySelectorAll('.food-component').forEach(initializeNutrition);
 if(components.length){updateComponentTotals(form);initializeTotalWeight(form)}
}
const localFoodRefs={'毛豆':'169283','炒饭':'2708952','寿司':'2708959','拉面':'2709153','味噌汤':'2707455'};
async function loadFoods(){if(!state.foods.length){const response=await fetch('foods.json');if(!response.ok)throw new Error('食物库暂时无法加载');state.foods=(await response.json()).foods}}
function foodEstimate(food){const estimate={...food,grams:100};for(const key of ['calories','carbs','protein','fat'])estimate[key]=Math.round(food[key]*10)/10;return estimate}
function mealDraft(form){return {day:form.elements.day.value,category:form.elements.category.value,record_time:form.elements.record_time.value,timeAuto:form.dataset.timeAuto==='1',categoryAuto:form.dataset.categoryAuto==='1'}}
function inferMealCategory(form){const category=categoryForTime(form.elements.record_time.value);if(form.dataset.categoryAuto==='1'&&category)form.elements.category.value=category}
async function foodLibrary(draft=null){
 await loadFoods();
 foodLibraryDraft=draft;
 openSheet(`${sheetTop('食物库')}<p class="sheet-description">搜索常见食材。数值来自 USDA 数据库，做法和份量不同会影响结果。</p><label class="field"><span>搜索食物</span><input id="food-search" type="search" placeholder="例如：米饭、鸡蛋、苹果" autocomplete="off"></label><div id="food-results"></div>`);
 renderFoodResults('');
}
function renderFoodResults(query){
 const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);const matches=state.foods.filter(f=>words.every(w=>`${f.name} ${f.keywords} ${f.source_name}`.toLowerCase().includes(w))).slice(0,30);
 $('#food-results',sheet).innerHTML=matches.length?matches.map(f=>`<button class="food-option" data-action="choose-food" data-id="${f.id}"><span><strong>${esc(f.name)}</strong><small>${round(f.calories)} 千卡 / 100 克</small></span>${icon('chevron')}</button>`).join(''):`<p class="panel-note">没有找到相关食物，可以返回后手动记录。</p>`;
}
function sharedMealSheet(meal,token){const details=meal.components?.length?meal.components:[meal];const stickerUrl=token==='buddy'?`api/buddy/meals/${meal.id}/sticker`:`api/shared/${encodeURIComponent(token)}/image/${meal.id}/sticker`;openSheet(`${sheetTop(meal.name)}${meal.has_sticker?`<div class="preview">${pic(meal,'sticker',token)}</div><a class="text-button" href="${stickerUrl}" download="food-sticker.png">保存透明贴纸</a>`:''}${meal.record_time?`<div class="stat-line"><span>记录时间</span><strong>${esc(meal.record_time)}（记录者当地时间）</strong></div>`:''}<div class="stat-line"><span>总热量</span><strong>${round(meal.calories)} 千卡</strong></div><div class="stat-line"><span>总重量</span><strong>${round(meal.grams)} 克</strong></div><div class="section-head" style="margin-top:20px"><h3>食物明细</h3></div><div class="shared-details">${details.map(item=>`<div class="share-item"><div><strong>${esc(item.name)}</strong><small>${round(item.grams)} 克 · 碳水 ${round(item.carbs)} 克 · 蛋白质 ${round(item.protein)} 克 · 脂肪 ${round(item.fat)} 克</small></div><strong>${round(item.calories)} 千卡</strong></div>`).join('')}</div><p class="privacy-copy">这是只读分享，营养数值仅供参考。</p>`)}
function previewStickerStyle(form){
 const image=$('#sticker-style-image',form),border=Number(form.elements.border.value),color=form.elements.color.value;
 if(!border){image.style.filter='drop-shadow(0 3px 3px #2222)';return}
 const n=border===1?1:2;
 image.style.filter=[[n,0],[-n,0],[0,n],[0,-n]].map(([x,y])=>`drop-shadow(${x}px ${y}px 0 ${color})`).join(' ');
}
function stickerEditor(meal){
 const border=Number(meal.sticker_border)||0,color=/^#[0-9a-f]{6}$/i.test(meal.sticker_color||'')?meal.sticker_color:'#ffffff';
 openSheet(`${sheetTop('编辑贴纸')}<form id="sticker-style-form" data-id="${meal.id}"><div class="sticker-style-preview"><img id="sticker-style-image" data-picture-src="api/meals/${meal.id}/sticker-source?size=thumbnail" alt="${esc(meal.name)}的贴纸预览"></div><p class="panel-note sticker-style-note">调整边框，给这份美味换个样子。</p><fieldset class="border-choice"><legend>边框粗细</legend><div class="border-options">${[[0,'无边框'],[1,'细边框'],[2,'粗边框']].map(([value,label])=>`<label><input type="radio" name="border" value="${value}" ${border===value?'checked':''}><span>${label}</span></label>`).join('')}</div></fieldset><label class="sticker-color"><span>边框颜色</span><input type="color" name="color" value="${esc(color)}" aria-label="边框颜色"></label><p class="ai-note">分享和下载会使用保存后的样式。自动抠图可能保留部分背景，请先检查。</p><p class="form-error" role="alert"></p><div class="sheet-footer"><button class="button" type="submit" disabled>保存贴纸</button></div></form>`);
 const form=$('#sticker-style-form',sheet),image=$('#sticker-style-image',form),save=$('[type="submit"]',form);
 image.addEventListener('load',()=>{save.disabled=false});image.addEventListener('error',()=>formError(form,'贴纸暂时无法加载，请关闭后重试。'));
 previewStickerStyle(form);
}
function exerciseForm(item=null){const editing=Boolean(item);openSheet(`${sheetTop(editing?'编辑运动':'记录运动')}<p class="sheet-description">填写运动设备或其他来源提供的消耗数据，热量将计入当天总览。</p><form id="exercise-form" data-id="${item?.id||''}"><label class="field"><span>运动名称</span><input name="name" maxlength="40" required placeholder="例如：散步" value="${esc(item?.name||'')}"></label><label class="field"><span>日期</span><input type="date" name="day" value="${item?.day||state.day}" required></label><div class="form-grid"><label class="field"><span>时长 · 分钟</span><input type="number" name="minutes" min="1" max="1440" step="1" required value="${item?.minutes??''}"></label>${numberField('calories','消耗 · 千卡',item?.calories??'',true)}</div><p class="form-error" role="alert"></p><div class="sheet-footer">${editing?`<button class="button secondary danger" type="button" data-action="confirm-delete-exercise" data-id="${item.id}">删除</button>`:''}<button class="button" type="submit">保存运动</button></div></form>`)}
function settingsSheet(){const u=state.user;openSheet(`${sheetTop('目标与识别设置')}<form id="settings-form"><label class="field"><span>每日热量目标 · 千卡</span><input type="number" name="target" value="${u.target}" min="500" max="10000" required><small>默认目标仅为初始值，请根据自己的情况调整。</small></label><div class="form-grid three">${[['carbs_goal','碳水 · 克'],['protein_goal','蛋白质 · 克'],['fat_goal','脂肪 · 克']].map(([field,label])=>`<label class="field"><span>${label}</span><input type="number" name="${field}" min="0.1" max="2000" step="0.1" placeholder="不设置" value="${esc(u[field]??'')}"></label>`).join('')}</div><p class="panel-note">营养目标可按个人需要填写，留空表示不设置。</p><label class="field"><span>照片识别服务</span><select name="provider"><option value="local" ${u.provider==='local'?'selected':''}>本地识别</option><option value="deepseek" ${u.provider==='deepseek'?'selected':''}>DeepSeek</option><option value="openai" ${u.provider==='openai'?'selected':''}>OpenAI</option></select></label><div id="provider-fields" ${u.provider==='local'?'hidden':''}><label class="field"><span>模型名称</span><input name="model" value="${esc(u.model)}" placeholder="输入支持图片的模型名称"><small>DeepSeek 推荐 deepseek-flash，deepseek-v4-pro 暂不支持图片；OpenAI 默认 gpt-4o-mini。</small></label><label class="field"><span>API 密钥</span><input name="api_key" type="password" autocomplete="off" placeholder="${u.has_key?'已配置；留空保持不变':'输入你的 API 密钥'}"><small>两家服务的密钥分开加密保存，留空可保留已保存的密钥。识别照片会发送至所选服务商，并可能产生费用。</small></label><label><input type="checkbox" name="clear_key"> <span class="panel-note">清除当前保存的密钥</span></label>${u.provider==='openai'&&u.has_key?'<p><button class="text-button" type="button" data-action="check-openai">检测已保存的 OpenAI 配置</button></p>':''}</div><p class="form-error" role="alert"></p><div class="sheet-footer"><button class="button" type="submit">保存设置</button></div></form>`)}
function shareSheet(){const links=state.shares.map(s=>`<div class="share-item"><div>${esc(s.day)}<small>有效至 ${new Date(s.expires*1000).toLocaleDateString('zh-CN')}</small></div><button class="text-button" data-action="copy-share" data-token="${esc(s.token)}">复制</button><button class="text-button danger" data-action="revoke" data-id="${s.id}">撤销</button></div>`).join('');
 openSheet(`${sheetTop('分享管理')}<p class="sheet-description">链接可查看对应日期的餐食、记录时间和贴纸，原照片不会分享。自动抠图可能保留部分背景，请先查看贴纸。链接 7 天后自动失效，也可随时撤销。</p><button class="button full" data-action="create-share">${icon('share')}生成 ${dateLabel(state.day)} 的分享链接</button><div style="margin-top:16px">${links||'<p class="panel-note">还没有有效的分享链接。</p>'}</div>`)}
function buddySettingsSheet(){const buddy=state.buddy;if(!buddy?.paired)return;openSheet(`${sheetTop('共享设置')}<p class="sheet-description">${buddy.sharing?'对方可以查看你的热量、餐食的记录时间和食物贴纸。':'你已暂停向对方共享。'}原照片不会分享，双方都可以随时暂停或解除绑定。</p><button class="button secondary full" data-action="toggle-buddy" data-enabled="${!buddy.sharing}">${buddy.sharing?'暂停我的共享':'恢复我的共享'}</button><button class="button outline full push-settings-entry" data-action="push-settings">搭子更新提醒</button><button class="text-button danger buddy-unbind" data-action="confirm-unbind">解除绑定</button>`)}
function weightSheet(){openSheet(`${sheetTop('体重记录')}<form id="weight-form"><div class="form-grid"><label class="field"><span>日期</span><input type="date" name="day" value="${state.day}" required></label><label class="field"><span>体重 · 千克</span><input type="number" name="weight" min="10" max="500" step="0.1" required placeholder="例如 60.5"></label></div><p class="form-error" role="alert"></p><button class="button full" type="submit">保存体重</button></form><div style="margin-top:16px">${state.weights.map(w=>`<div class="share-item"><div>${esc(w.day)}<small>${w.weight} 千克</small></div><button class="text-button danger" data-action="confirm-delete-weight" data-day="${esc(w.day)}">删除</button></div>`).join('')||'<p class="panel-note">还没有体重记录。</p>'}</div>`)}
function mealSplitSheet(){
 const split=state.user.meal_split||{breakfast:25,lunch:35,dinner:30,snack:10};
 const fields=cats.map(([id,label])=>`<label class="field"><span>${label} · %</span><input type="number" name="${id}" min="0" max="100" step="1" inputmode="numeric" required value="${esc(split[id])}"><small data-target="${id}"></small></label>`).join('');
 openSheet(`${sheetTop('餐次热量分配')}<p class="sheet-description">按当前每日目标 ${round(state.user.target)} 千卡分配四餐，比例合计为 100%。历史日期也使用当前设置，不含运动消耗。</p><form id="meal-split-form"><div class="form-grid">${fields}</div><p class="meal-split-total" id="meal-split-total" role="status"></p><p class="panel-note meal-split-note">${state.user.meal_split?'':'首次显示的比例只是示例，请按自己的习惯调整。'}开启搭子共享时，对方也能看到这些目标。</p><p class="form-error" role="alert"></p><div class="sheet-footer">${state.user.meal_split?'<button class="button secondary" type="button" data-action="clear-meal-split">清除分配</button>':''}<button class="button" type="submit">保存分配</button></div></form>`);
 updateMealSplit($('#meal-split-form',sheet));
}
function updateMealSplit(form){
 const fields=cats.map(([id])=>form.elements[id]);
 const valid=fields.every(field=>field.value!==''&&field.validity.valid);
 const sum=valid?fields.reduce((total,field)=>total+Number(field.value),0):null;
 const split=valid?Object.fromEntries(cats.map(([id])=>[id,Number(form.elements[id].value)])):null;
 const targets=sum===100?mealTargets(state.user.target,split):null;
 for(const [id] of cats)$(`[data-target="${id}"]`,form).textContent=targets?`${targets[id]} 千卡`:'—';
 const status=$('#meal-split-total',form);
 status.textContent=sum===null?'请填写 0 至 100 的整数比例':sum===100?'已分配 100%':sum<100?`已分配 ${sum}%，还差 ${100-sum}%`:`已分配 ${sum}%，超出 ${sum-100}%`;
 status.classList.toggle('invalid',sum!==100);
}
function pushSupported(){return window.isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}
async function pushRegistration(){
 let timer;try{return await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('通知服务尚未就绪，请稍后重试')),10000)})])}finally{clearTimeout(timer)}
}
async function currentPushSubscription(){
 if(!pushSupported())return null;
 const registration=await navigator.serviceWorker.getRegistration();
 return registration?registration.pushManager.getSubscription():null;
}
async function pushStatus(endpoint){
 const response=await fetch('api/push/status',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint})});
 if(!response.ok)throw new Error('无法检查本机提醒状态，请稍后重试');
 return (await response.json()).enabled;
}
function pushSettingsSheet(){
 openSheet(`${sheetTop('搭子更新提醒')}<section id="push-settings"><p class="sheet-description">搭子共享并记录新餐食时，本机会收到提醒。通知不包含食物照片或营养数据。</p><div id="push-state" aria-live="polite"><p class="panel-note">正在检查本机通知设置…</p></div><p class="form-error" id="push-error" role="alert"></p></section>`);
 refreshPushSettings($('#push-settings',sheet));
}
function pushError(panel,message){const error=$('#push-error',panel);if(error){error.textContent=message;error.classList.add('visible')}}
async function refreshPushSettings(panel){
 const target=$('#push-state',panel);if(!target)return;
 if(!pushSupported()){
  target.innerHTML='<p class="panel-note">当前浏览器暂不支持通知。iPhone 或 iPad 请先在 Safari 中选择“分享 → 添加到主屏幕”，再从主屏幕打开并开启提醒。</p>';return;
 }
 try{
  const registration=await pushRegistration(),subscription=await registration.pushManager.getSubscription();
  const enabled=subscription?await pushStatus(subscription.endpoint):false;
  if(!panel.isConnected)return;
  const denied=Notification.permission==='denied';
  target.innerHTML=`<p class="panel-note">${enabled?'本机已开启提醒。':'本机尚未开启提醒。'}${denied?'系统或浏览器已关闭通知权限，请在设置中允许。':''}</p>${enabled?'<button class="button secondary full push-settings-entry" type="button" data-action="push-disable">关闭本机提醒</button>':denied?'':'<button class="button full push-settings-entry" type="button" data-action="push-enable">开启本机提醒</button>'}`;
 }catch(error){if(panel.isConnected)pushError(panel,error.message)}
}
function pushKey(value){const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function enablePush(button){
 const panel=button.closest('#push-settings');button.disabled=true;$('#push-error',panel).classList.remove('visible');
 try{
  const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
  if(permission!=='granted')throw new Error('未获得通知权限，请在手机或浏览器设置中允许');
  const config=await api('push/config'),registration=await pushRegistration(),key=pushKey(config.public_key);
  const previous=await registration.pushManager.getSubscription();let subscription=previous;
  if(previous){const old=previous.options?.applicationServerKey?new Uint8Array(previous.options.applicationServerKey):null;
   if(!old||old.length!==key.length||old.some((value,index)=>value!==key[index])){await previous.unsubscribe();subscription=null}}
  const created=!subscription;
  if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  try{await api('push/subscription',{method:'POST',body:{subscription:subscription.toJSON(),previous_endpoint:previous?.endpoint}})}
  catch(error){if(created)await subscription.unsubscribe().catch(()=>{});throw error}
  if(panel.isConnected){await refreshPushSettings(panel);toast('本机提醒已开启')}
 }catch(error){if(panel.isConnected)pushError(panel,/^[\x00-\x7f]*$/.test(error.message||'')?'无法开启提醒，请检查手机通知权限和网络后重试':error.message)}
 finally{button.disabled=false}
}
async function disablePush(button){
 const panel=button.closest('#push-settings');button.disabled=true;$('#push-error',panel).classList.remove('visible');
 try{
  const subscription=await currentPushSubscription();
  if(subscription){await api('push/subscription',{method:'DELETE',body:{endpoint:subscription.endpoint}});await subscription.unsubscribe()}
  if(panel.isConnected){await refreshPushSettings(panel);toast('本机提醒已关闭')}
 }catch(error){if(panel.isConnected)pushError(panel,error.message||'无法关闭提醒，请稍后重试')}
 finally{button.disabled=false}
}
async function preparePhoto(file){
 if(!file)return;const version=++state.scanVersion;
 if(scanPreviewUrl)URL.revokeObjectURL(scanPreviewUrl);
 const previewUrl=URL.createObjectURL(file);scanPreviewUrl=previewUrl;
 openSheet(`${sheetTop('正在识别')}<div class="scan-visual"><img src="${previewUrl}" alt="正在识别的食物照片"><div class="scan-shade"></div><div class="scan-frame"></div><div class="scan-beam"></div><div class="scan-badge">${icon('spark')}<span>食物识别中</span></div></div><div class="scan-copy"><h3>正在认识你的这一餐</h3><p id="scan-status" role="status" aria-live="polite">正在准备照片…</p></div><div class="scan-steps" id="scan-steps" data-stage="prepare"><div class="scan-step"><span class="scan-step-icon">1</span><span>准备照片</span></div><span class="scan-connector"></span><div class="scan-step"><span class="scan-step-icon">2</span><span>生成贴纸与分析</span></div></div><p class="scan-hint">识别时间取决于图片、网络和所选模型，请稍候。</p>`);
 try{
  const blob=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');const scale=Math.min(1,1280/Math.max(image.width,image.height));canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);canvas.toBlob(b=>b?resolve(b):reject(new Error('无法读取照片')),'image/jpeg',.88)};image.onerror=()=>reject(new Error('无法读取照片，请换一张图片'));image.src=previewUrl});
  if(version!==state.scanVersion)return;
  $('#scan-steps',sheet).dataset.stage='analyze';$('#scan-status',sheet).textContent='正在生成贴纸并分析食物…';
  const form=new FormData();form.append('image',blob,'food.jpg');const analysis=await api('analyze',{method:'POST',body:form});if(version!==state.scanVersion)return;if(analysis.source==='local'&&analysis.candidates?.length){try{await loadFoods();const food=state.foods.find(f=>f.id===localFoodRefs[analysis.candidates[0].name]);if(food){state.foodRef=food;state.nutritionEdited=false;analysis.estimate=foodEstimate(food);analysis.local_reference=true}}catch{}}if(version!==state.scanVersion)return;state.image=analysis;mealForm(null,analysis);
 }catch(e){if(version!==state.scanVersion)return;openSheet(`${sheetTop('识别未完成')}<p class="sheet-description">${esc(e.message)}</p><button class="button full" data-action="manual">手动记录</button>`)}
 finally{if(scanPreviewUrl===previewUrl){URL.revokeObjectURL(previewUrl);scanPreviewUrl=null}}
}
async function retryRecognition(button){
 const form=button.closest('#meal-form'),hint=$('#recognition-hint',form),error=$('#recognition-retry-error',form);
 const text=hint.value.trim();error.textContent='';error.classList.remove('visible');
 if(!text){error.textContent='请先填写菜名或配料说明。';error.classList.add('visible');hint.focus();return}
 const original=state.image,version=state.scanVersion;
 const draft=mealDraft(form);
 const controls=[...form.querySelectorAll('input,select,button'),...sheet.querySelectorAll('[data-action="vision-candidate"]')].map(element=>({element,disabled:element.disabled}));
 controls.forEach(({element})=>{element.disabled=true});button.textContent='正在重新识别…';
 try{
  if(!original?.photo?.startsWith('data:image/jpeg;base64,'))throw new Error('原照片不可用，请重新选择照片。');
  const raw=atob(original.photo.split(',')[1]),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  const data=new FormData();data.append('image',new Blob([bytes],{type:'image/jpeg'}),'food.jpg');data.append('hint',text);
  const result=await api('reanalyze',{method:'POST',body:data});
  if(version!==state.scanVersion||!sheet.open||!form.isConnected||state.image!==original)return;
  const analysis={...original,...result,recognition_error:null,candidates:[]};
  state.image=analysis;state.foodRef=null;state.nutritionEdited=false;mealForm(null,analysis,draft);toast('重新识别完成，请核对结果');
 }catch(e){
  if(version===state.scanVersion&&sheet.open&&form.isConnected){error.textContent=e.message;error.classList.add('visible')}
 }finally{controls.forEach(({element,disabled})=>{element.disabled=disabled});button.textContent='根据说明重新识别'}
}
async function showBuddyInvite(){
 if(!state.buddyToken||!state.user)return;
 try{const result=await api(`buddy/invites/${encodeURIComponent(state.buddyToken)}`);
 openSheet(`${sheetTop('搭子邀请')}<p class="sheet-description"><strong>${esc(result.username)}</strong> 邀请你一起记录。接受后，你们可以互看每日热量、餐食的记录时间和食物贴纸；双方都可随时暂停自己的共享或解除绑定。</p><div class="two-buttons"><button class="button secondary" data-action="dismiss-invite">暂不接受</button><button class="button" data-action="accept-buddy">接受邀请</button></div>`);
 }catch(e){state.buddyToken=null;history.replaceState(null,'',location.pathname);toast(e.message)}
}
async function copyBuddyInvite(token){const url=new URL('./',location.href);url.searchParams.set('invite',token);try{await navigator.clipboard.writeText(url.href);toast('搭子邀请链接已复制')}catch{openSheet(`${sheetTop('复制搭子邀请')}<p class="sheet-description">长按链接复制，发给你信任的人。邀请链接 24 小时内有效。</p><label class="field"><span>邀请链接</span><input value="${esc(url.href)}" readonly></label>`);$('input',sheet)?.select()}}
async function copyShare(token){const url=new URL('./',location.href);url.searchParams.set('share',token);try{await navigator.clipboard.writeText(url.href);toast('分享链接已复制')}catch{openSheet(`${sheetTop('复制分享链接')}<p class="sheet-description">长按下方链接复制，发送给你的搭子。</p><label class="field"><span>分享链接</span><input value="${esc(url.href)}" readonly></label>`);$('input',sheet)?.select()}}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 const action=button.dataset.action;
 try{
  if(action==='close'){closeSheet();return}
  if(action==='auth-mode'){renderAuth(button.dataset.mode);return}
  if(action==='nav'){state.view=button.dataset.view;await loadView({instant:true});return}
  if(action==='date'){state.day=button.dataset.day;await loadView({instant:true});return}
  if(action==='retry-view'){await loadView({instant:true});return}
  if(action==='layout'){state.layout=button.dataset.layout;render();return}
  if(action==='calendar'){openSheet(`${sheetTop('选择日期')}<form id="date-form"><label class="field"><span>查看哪一天</span><input type="date" name="day" value="${state.day}" required></label><button class="button full" type="submit">查看记录</button></form>`);return}
  if(action==='add'){state.image=null;state.foodRef=null;state.nutritionEdited=false;addSheet(button.dataset.category);return}
  if(action==='manual'){state.image=null;state.foodRef=null;state.nutritionEdited=false;mealForm();return}
  if(action==='add-component'){
   const form=$('#meal-form',sheet),list=$('#component-list',form);const existing=list.querySelectorAll('.food-component');
   if(existing.length>=12){toast('最多添加 12 项食物');return}
   if(!existing.length){const first={name:$('[name="name"]',form).value};for(const key of ['grams','calories','carbs','protein','fat'])first[key]=$(`[name="${key}"]`,form).value;list.insertAdjacentHTML('beforeend',componentMarkup(first));initializeNutrition(list.lastElementChild)}
   list.insertAdjacentHTML('beforeend',componentMarkup());initializeNutrition(list.lastElementChild);state.foodRef=null;state.nutritionEdited=true;const library=$('[data-action="food-library"]',form);if(library)library.hidden=true;updateComponentTotals(form);initializeTotalWeight(form);return;
  }
  if(action==='remove-component'){const form=$('#meal-form',sheet);button.closest('.food-component').remove();const library=$('[data-action="food-library"]',form);if(library&&!form.querySelector('.food-component'))library.hidden=false;updateComponentTotals(form);if(!form.querySelector('.food-component'))initializeNutrition(form);else initializeTotalWeight(form);return}
  if(action==='food-library'){const form=$('#meal-form',sheet);await foodLibrary(form?mealDraft(form):null);return}
  if(action==='choose-food'){const food=state.foods.find(f=>f.id===button.dataset.id);if(!food)return;state.foodRef=food;state.nutritionEdited=false;const estimate=foodEstimate(food);mealForm(null,{...(state.image||{}),recognition_error:null,source:'catalog',estimate},foodLibraryDraft||{});foodLibraryDraft=null;return}
  if(action==='camera'||action==='gallery'){$(`#${action}-input`).click();return}
  if(action==='candidate'){const form=$('#meal-form',sheet),name=button.dataset.name;const food=state.foods.find(f=>f.id===localFoodRefs[name]);state.foodRef=food||null;state.nutritionEdited=false;const estimate=food?foodEstimate(food):null;$('[name="name"]',form).value=food?food.name:name;for(const key of ['grams','calories','carbs','protein','fat'])$(`[name="${key}"]`,form).value=estimate?.[key]??'';initializeNutrition(form);const note=$('#nutrition-note',form);if(note)note.textContent=food?'已按 100 克参考数据填写，请核对份量和做法。':'此候选暂无匹配的营养数据，请从食物库选择或手动填写。';sheet.querySelectorAll('.candidate').forEach(x=>x.classList.toggle('active',x===button));return}
  if(action==='vision-candidate'){const form=$('#meal-form',sheet);$('[name="name"]',form).value=button.dataset.name;const hint=$('#recognition-hint',form);if(hint&&!hint.value)hint.value=button.dataset.name;state.foodRef=null;state.nutritionEdited=true;const message='已切换菜名，食物明细和热量仍为原估算，请核对或补充说明后重新识别。';const note=$('#nutrition-note',form),choice=$('#vision-choice-note',sheet);if(note)note.textContent=message;if(choice){choice.textContent=message;choice.hidden=false}sheet.querySelectorAll('[data-action="vision-candidate"]').forEach(x=>x.classList.toggle('active',x===button));return}
  if(action==='retry-recognition'){await retryRecognition(button);return}
  if(action==='view-shared-meal'){const source=state.shareToken?state.shared:state.buddy;const item=source?.meals.find(m=>m.id===button.dataset.id);if(item)sharedMealSheet(item,state.shareToken||'buddy');return}
  if(action==='edit'){const m=state.meals.find(x=>x.id===button.dataset.id);if(m){state.image=null;state.foodRef=null;state.nutritionEdited=false;mealForm(m)}return}
  if(action==='edit-sticker'){const m=state.meals.find(x=>x.id===button.dataset.id);if(m?.has_sticker)stickerEditor(m);return}
  if(action==='confirm-delete'){const m=state.meals.find(x=>x.id===button.dataset.id);if(!m)return;openSheet(`${sheetTop('删除这条记录？')}<p class="sheet-description">删除后无法恢复「${esc(m.name)}」及对应的贴纸。</p><div class="two-buttons"><button class="button secondary" data-action="close">取消</button><button class="button" data-action="delete" data-id="${m.id}">确认删除</button></div>`);return}
  if(action==='delete'){await api(`meals/${button.dataset.id}`,{method:'DELETE'});closeSheet();await loadView();toast('已删除饮食记录');return}
  if(action==='add-exercise'){exerciseForm();return}
  if(action==='edit-exercise'){const item=state.exercises.find(e=>e.id===button.dataset.id);if(item)exerciseForm(item);return}
  if(action==='confirm-delete-exercise'){openSheet(`${sheetTop('删除这条运动？')}<p class="sheet-description">删除后将从当天热量总览中移除。</p><div class="two-buttons"><button class="button secondary" data-action="close">取消</button><button class="button" data-action="delete-exercise" data-id="${button.dataset.id}">确认删除</button></div>`);return}
  if(action==='delete-exercise'){await api(`exercises/${button.dataset.id}`,{method:'DELETE'});closeSheet();await loadView();toast('运动记录已删除');return}
  if(action==='start-fast'){await api('fasts',{method:'POST',body:{goal_hours:Number($('#fast-goal').value)}});await loadView();toast('计时已开始');return}
  if(action==='confirm-end-fast'){openSheet(`${sheetTop('结束本次计时？')}<p class="sheet-description">结束后会保存本次开始时间和实际时长。</p><div class="two-buttons"><button class="button secondary" data-action="close">继续计时</button><button class="button" data-action="end-fast">结束计时</button></div>`);return}
  if(action==='end-fast'){await api('fasts/end',{method:'POST',body:{}});closeSheet();await loadView();toast('计时已保存');return}
  if(action==='confirm-delete-fast'){openSheet(`${sheetTop('删除这次计时？')}<p class="sheet-description">删除后无法恢复这条计时记录。</p><div class="two-buttons"><button class="button secondary" data-action="close">取消</button><button class="button" data-action="delete-fast" data-id="${button.dataset.id}">确认删除</button></div>`);return}
  if(action==='delete-fast'){await api(`fasts/${button.dataset.id}`,{method:'DELETE'});closeSheet();await loadView();toast('记录已删除');return}
  if(action==='buddy'){state.view='buddy';await loadView({instant:true});return}
  if(action==='buddy-settings'){buddySettingsSheet();return}
  if(action==='meal-split'){mealSplitSheet();return}
  if(action==='clear-meal-split'){button.disabled=true;try{const result=await api('settings',{method:'PUT',body:{meal_split:null}});state.user=result.user;closeSheet();render();toast('餐次分配已清除')}finally{button.disabled=false}return}
  if(action==='push-settings'){pushSettingsSheet();return}
  if(action==='push-enable'){await enablePush(button);return}
  if(action==='push-disable'){await disablePush(button);return}
  if(action==='invite-buddy'){const result=await api('buddy/invites',{method:'POST',body:{}});await copyBuddyInvite(result.token);return}
  if(action==='dismiss-invite'){state.buddyToken=null;history.replaceState(null,'',location.pathname);closeSheet();return}
  if(action==='accept-buddy'){await api('buddy/accept',{method:'POST',body:{token:state.buddyToken}});state.buddyToken=null;history.replaceState(null,'',location.pathname);closeSheet();state.view='buddy';await loadView();toast('已绑定搭子');return}
  if(action==='toggle-buddy'){await api('buddy/sharing',{method:'PUT',body:{enabled:button.dataset.enabled==='true'}});closeSheet();await loadView();toast('共享状态已更新');return}
  if(action==='confirm-unbind'){openSheet(`${sheetTop('解除搭子绑定？')}<p class="sheet-description">解除后，双方将无法继续查看彼此的热量和贴纸。已有的单日分享链接不受影响。</p><div class="two-buttons"><button class="button secondary" data-action="close">取消</button><button class="button" data-action="unbind-buddy">确认解除</button></div>`);return}
  if(action==='unbind-buddy'){await api('buddy',{method:'DELETE',body:{}});closeSheet();await loadView();toast('已解除搭子关系');return}
  if(action==='settings'){settingsSheet();return}
  if(action==='check-openai'){button.disabled=true;try{const result=await api('settings/check',{method:'POST',body:{}});toast(result.message)}finally{button.disabled=false}return}
  if(action==='confirm-delete-weight'){openSheet(`${sheetTop('删除体重记录？')}<p class="sheet-description">删除后无法恢复 ${esc(button.dataset.day)} 的体重记录。</p><div class="two-buttons"><button class="button secondary" data-action="weight">取消</button><button class="button" data-action="delete-weight" data-day="${esc(button.dataset.day)}">确认删除</button></div>`);return}
  if(action==='delete-weight'){await api(`weights/${button.dataset.day}`,{method:'DELETE'});state.weights=(await api('weights')).weights;weightSheet();render();toast('体重记录已删除');return}
  if(action==='weight'){weightSheet();return}
  if(action==='water'){const amount=Math.max(0,Math.min(10000,state.water+Number(button.dataset.amount)));state.water=(await api('water',{method:'PUT',body:{day:state.day,amount}})).amount;render();return}
  if(action==='share'||action==='manage-shares'){state.shares=(await api('shares')).shares;shareSheet();return}
  if(action==='create-share'){button.disabled=true;state.shares=(await api('shares',{method:'POST',body:{day:state.day}})).shares;const link=state.shares[0];shareSheet();await copyShare(link.token);return}
  if(action==='copy-share'){await copyShare(button.dataset.token);return}
  if(action==='revoke'){await api(`shares/${button.dataset.id}`,{method:'DELETE'});state.shares=(await api('shares')).shares;shareSheet();toast('分享链接已撤销');return}
  if(action==='delete-account'){openSheet(`${sheetTop('删除账号及数据')}<p class="sheet-description">此操作会从应用中删除账号、饮食照片、贴纸、运动、体重、断食和全部分享链接，无法撤销。服务器已有备份不会自动删除，请由管理员单独处理。</p><form id="delete-account-form"><label class="field"><span>输入密码以确认</span><input type="password" name="password" autocomplete="current-password" required></label><p class="form-error" role="alert"></p><div class="sheet-footer"><button class="button secondary" type="button" data-action="close">取消</button><button class="button" type="submit">永久删除</button></div></form>`);return}
  if(action==='logout'){const subscription=await currentPushSubscription().catch(()=>null);const result=await api('auth/logout',{method:'POST',body:{push_endpoint:subscription?.endpoint}});if(subscription&&result.push_removed)await subscription.unsubscribe().catch(()=>{});state.user=null;state.meals=[];render();return}
 }catch(e){button.disabled=false;toast(e.message)}
});

document.addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target;const values=Object.fromEntries(new FormData(form).entries());const submit=$('[type="submit"]',form);if(submit)submit.disabled=true;
 try{
  if(form.id==='auth-form'){
    const result=await api(`auth/${form.dataset.mode}`,{method:'POST',body:values});state.user=result.user;state.view='today';state.day=today();applyPendingBuddy();await loadView();await showBuddyInvite();return;
  }
  if(form.id==='delete-account-form'){const subscription=await currentPushSubscription().catch(()=>null);const result=await api('account',{method:'DELETE',body:{...values,push_endpoint:subscription?.endpoint}});if(subscription&&result.push_removed)await subscription.unsubscribe().catch(()=>{});state.user=null;state.meals=[];state.shares=[];closeSheet();render();toast('账号及数据已删除');return}
  if(form.id==='date-form'){state.day=values.day;closeSheet();await loadView({instant:true});return}
  if(form.id==='meal-form'){
    const id=form.dataset.id;const payload={...values};payload.components=[...form.querySelectorAll('.food-component')].map(item=>Object.fromEntries([...item.querySelectorAll('[data-component-field]')].map(input=>[input.dataset.componentField,input.value])));if(!id&&state.image){payload.photo=state.image.photo;payload.sticker=state.image.sticker}
    await api(id?`meals/${id}`:'meals',{method:id?'PUT':'POST',body:payload});state.day=values.day;state.image=null;closeSheet();await loadView();toast(id?'记录已更新':'已保存饮食记录');return;
  }
  if(form.id==='sticker-style-form'){submit.textContent='正在保存…';await api(`meals/${form.dataset.id}/sticker-style`,{method:'PUT',body:{border:Number(values.border),color:values.color}});closeSheet();await loadView();toast('贴纸样式已保存');return}
  if(form.id==='meal-split-form'){
    const split=Object.fromEntries(cats.map(([id])=>[id,Number(values[id])]));
    if(cats.some(([id])=>values[id]===''||!form.elements[id].validity.valid)||Object.values(split).reduce((sum,value)=>sum+value,0)!==100){formError(form,'四餐比例合计需为 100%');return}
    const result=await api('settings',{method:'PUT',body:{meal_split:split}});state.user=result.user;closeSheet();render();toast('餐次分配已保存');return;
  }
  if(form.id==='settings-form'){
    values.clear_key=Boolean(values.clear_key);const result=await api('settings',{method:'PUT',body:values});state.user=result.user;closeSheet();render();toast('设置已保存');return;
  }
  if(form.id==='exercise-form'){const id=form.dataset.id;await api(id?`exercises/${id}`:'exercises',{method:id?'PUT':'POST',body:values});state.day=values.day;closeSheet();await loadView();toast(id?'运动已更新':'运动已记录');return}
  if(form.id==='weight-form'){
    state.weights=(await api('weights',{method:'POST',body:values})).weights;weightSheet();render();toast('体重已记录');return;
  }
 }catch(e){formError(form,e.message)}finally{if(submit){submit.disabled=false;if(form.id==='sticker-style-form')submit.textContent='保存贴纸'}}
});

document.addEventListener('input',event=>{
 if(event.target.id==='food-search'){renderFoodResults(event.target.value);return}
 if(event.target.closest('#sticker-style-form')){previewStickerStyle(event.target.closest('#sticker-style-form'));return}
 const splitForm=event.target.closest('#meal-split-form');if(splitForm){updateMealSplit(splitForm);$('.form-error',splitForm)?.classList.remove('visible');return}
 const form=event.target.closest('#meal-form');if(!form)return;
 if(event.target.name==='category'){form.dataset.categoryAuto='0';return}
 if(event.target.name==='record_time'){form.dataset.timeAuto='0';inferMealCategory(form);return}
 const component=event.target.closest('.food-component');
 if(component){const key=event.target.dataset.componentField;if(key==='grams')scaleNutrition(component);else if(nutrients.includes(key))setNutritionBase(component,key);updateComponentTotals(form);if(key==='grams')initializeTotalWeight(form);return}
 if(event.target.name==='grams'){if(form.querySelector('.food-component'))scaleComponents(form);else scaleNutrition(form);return}
 if(nutrients.includes(event.target.name)){setNutritionBase(form,event.target.name);state.nutritionEdited=true;const note=$('#nutrition-note',form);if(note)note.textContent='已按手动调整的营养值换算，保存前请核对。';return}
 if(!state.foodRef)return;
 if(event.target.name==='name'){state.foodRef=null;state.nutritionEdited=true;const note=$('#nutrition-note',form);if(note)note.textContent='名称已修改，请检查营养数据是否匹配。';return}
});

document.addEventListener('keydown',event=>{
 if(event.target.id==='recognition-hint'&&event.key==='Enter'){
  event.preventDefault();const retry=$('[data-action="retry-recognition"]',event.target.closest('#meal-form'));if(retry&&!retry.disabled)retry.click();
 }
});

document.addEventListener('change',event=>{
 const mealFormElement=event.target.closest('#meal-form');
 if(mealFormElement&&event.target.name==='category')mealFormElement.dataset.categoryAuto='0';
 if(mealFormElement&&event.target.name==='record_time'){mealFormElement.dataset.timeAuto='0';inferMealCategory(mealFormElement)}
 if(mealFormElement&&event.target.name==='day'&&mealFormElement.dataset.timeAuto==='1'){mealFormElement.elements.record_time.value=event.target.value===today()?localTime():'';inferMealCategory(mealFormElement)}
 if(event.target.matches('#camera-input,#gallery-input')){const file=event.target.files[0];event.target.value='';state.foodRef=null;state.nutritionEdited=false;preparePhoto(file)}
 if(event.target.closest('#sticker-style-form'))previewStickerStyle(event.target.closest('#sticker-style-form'));
 if(event.target.matches('#settings-form [name="provider"]')){
  const provider=event.target.value;$('#provider-fields',sheet).hidden=provider==='local';const saved=state.user.provider_options?.[provider];
  $('[name="model"]',sheet).value=saved?.model||(provider==='deepseek'?'deepseek-flash':provider==='openai'?'gpt-4o-mini':'');
  const key=$('[name="api_key"]',sheet);key.value='';key.placeholder=saved?.has_key?'已配置；留空保持不变':'输入你的 API 密钥';
  $('[name="clear_key"]',sheet).checked=false;
 }
});

setInterval(()=>{const clock=$('#fast-clock[data-started]');if(!clock)return;const elapsed=Math.max(0,Date.now()/1000-Number(clock.dataset.started));clock.textContent=duration(elapsed);const ring=$('#fast-ring');if(ring)ring.setAttribute('stroke-dasharray',`${(Math.min(1,elapsed/(Number(clock.dataset.goal)*3600))*427.3).toFixed(1)} 427.3`)},1000);

async function boot(){
 if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
 try{
  if(state.shareToken){try{state.shared=await api(`shared/${encodeURIComponent(state.shareToken)}`)}catch{state.shared=null}render();return}
  state.user=(await api('me')).user;if(state.user){applyPendingBuddy();await loadView();await showBuddyInvite()}else render();
 }catch(e){app.innerHTML=`<main id="main" class="screen no-nav">${topBar('轻食日记')}<div class="no-records">${icon('lock')}<strong>暂时无法连接服务</strong><p>${esc(e.message)}</p></div><p><button class="button full" data-action="reload">重新加载</button></p></main>`;}
}
document.addEventListener('click',event=>{if(event.target.closest('[data-action="reload"]'))location.reload()});
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',event=>{
 if(event.data?.type!=='buddy-notification')return;
 const day=validNoticeDay(event.data.day)?event.data.day:today();
 if(!state.user){pendingBuddyDay=day;return}
 if(sheet.open){toast('搭子有新记录，完成当前操作后可在搭子页查看');return}
 pendingBuddyDay=day;applyPendingBuddy();loadView({instant:true}).catch(error=>toast(error.message));
});
boot();

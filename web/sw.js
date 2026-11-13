const CACHE = 'food-diary-shell-v22';
const SHELL = ['./', './style.css', './app.js', './foods.json', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('food-diary-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request, {ignoreSearch: true})));
});

self.addEventListener('push', event => {
  let data={};try{data=event.data?.json()||{}}catch{}
  const day=typeof data.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(data.day)?data.day:'';
  const id=typeof data.id==='string'&&/^[a-f0-9]{32}$/.test(data.id)?data.id:'';
  event.waitUntil(self.registration.showNotification('轻食日记',{
    body:'你的搭子刚刚记录了一餐',icon:new URL('icon-192.png',self.registration.scope).href,tag:id?`buddy-${id}`:'buddy-update',data:{day}
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const day=event.notification.data?.day||'';
  event.waitUntil((async()=>{
    const target=new URL('./',self.registration.scope);target.searchParams.set('view','buddy');
    if(day)target.searchParams.set('day',day);
    const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
    const current=windows.find(client=>{const url=new URL(client.url);return url.origin===target.origin&&url.pathname.startsWith(new URL(self.registration.scope).pathname)&&!url.searchParams.has('share')});
    if(current){await current.focus();current.postMessage({type:'buddy-notification',day});return}
    await clients.openWindow(target.href);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async()=>{
    const old=event.oldSubscription;
    const subscription=event.newSubscription||(old?.options?.applicationServerKey?await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:old.options.applicationServerKey}):null);
    if(!subscription)return;
    await fetch(new URL('api/push/subscription',self.registration.scope),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:subscription.toJSON(),previous_endpoint:old?.endpoint})});
  })());
});

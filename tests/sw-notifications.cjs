const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

(async()=>{
  const handlers={},shown=[],messages=[],opened=[],requests=[];
  const registration={scope:'https://example.test/food-diary/',showNotification:async(title,options)=>shown.push({title,options})};
  const client={url:'https://example.test/food-diary/',focus:async()=>client,postMessage:value=>messages.push(value)};
  let windows=[client];
  const clients={matchAll:async()=>windows,openWindow:async url=>opened.push(url)};
  const self={registration,addEventListener:(type,handler)=>{handlers[type]=handler}};
  const fetch=async(url,options)=>{requests.push({url:String(url),options});return {ok:true}};
  vm.runInNewContext(fs.readFileSync('web/sw.js','utf8'),{self,clients,URL,fetch,Promise});

  let work;
  handlers.push({data:{json:()=>({day:'2026-11-13',id:'a'.repeat(32)})},waitUntil:value=>{work=value}});
  await work;
  assert.equal(shown[0].title,'轻食日记');
  assert.equal(shown[0].options.body,'你的搭子刚刚记录了一餐');
  assert.equal(shown[0].options.tag,'buddy-'+'a'.repeat(32));
  let closed=false;
  handlers.notificationclick({notification:{data:shown[0].options.data,close(){closed=true}},waitUntil:value=>{work=value}});
  await work;
  assert.equal(closed,true);
  assert.equal(messages[0].type,'buddy-notification');assert.equal(messages[0].day,'2026-11-13');
  windows=[{url:'https://example.test/food-diary/?share=secret'}];
  handlers.notificationclick({notification:{data:shown[0].options.data,close(){}},waitUntil:value=>{work=value}});
  await work;
  const destination=new URL(opened[0]);
  assert.equal(destination.pathname,'/food-diary/');assert.equal(destination.searchParams.get('view'),'buddy');
  assert.equal(destination.searchParams.get('day'),'2026-11-13');

  const old={endpoint:'https://fcm.googleapis.com/fcm/send/old'};
  const replacement={toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/new',keys:{}})};
  handlers.pushsubscriptionchange({oldSubscription:old,newSubscription:replacement,waitUntil:value=>{work=value}});
  await work;
  assert.equal(requests[0].url,'https://example.test/food-diary/api/push/subscription');
  assert.equal(requests[0].options.credentials,'same-origin');
  assert.equal(JSON.parse(requests[0].options.body).previous_endpoint,old.endpoint);
  console.log('Service worker notification checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1});

const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');

(async()=>{
  const base=process.env.FOOD_TEST_URL||'http://127.0.0.1:8792/';
  const origin=new URL(base).origin;
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['notifications']});
  const page=await context.newPage(),cdp=await context.newCDPSession(page);
  let registrations=[];
  cdp.on('ServiceWorker.workerRegistrationUpdated',event=>{registrations=event.registrations});
  try{
    await cdp.send('ServiceWorker.enable');await page.goto(base);await page.evaluate(()=>navigator.serviceWorker.ready);
    for(let attempt=0;attempt<30&&!registrations.some(item=>item.scopeURL===base);attempt++)await page.waitForTimeout(100);
    const registration=registrations.find(item=>item.scopeURL===base);
    assert.ok(registration,'service worker did not register');
    await cdp.send('ServiceWorker.deliverPushMessage',{origin,registrationId:registration.registrationId,
      data:JSON.stringify({day:'2026-11-13',id:'a'.repeat(32)})});
    await page.waitForFunction(async()=>{const worker=await navigator.serviceWorker.ready;return (await worker.getNotifications()).length>0});
    const result=await page.evaluate(async()=>{
      const worker=await navigator.serviceWorker.ready,items=await worker.getNotifications();
      return items.map(item=>{const info={title:item.title,body:item.body,day:item.data.day};item.close();return info});
    });
    assert.deepEqual(result,[{title:'轻食日记',body:'你的搭子刚刚记录了一餐',day:'2026-11-13'}]);
    console.log('Browser push event displayed a notification.');
  }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});

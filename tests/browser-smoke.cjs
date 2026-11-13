/* Run against a local test instance: FOOD_TEST_URL=http://127.0.0.1:8792/ npm run test:ui */
const { chromium } = require('playwright-core');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');

const base = process.env.FOOD_TEST_URL || 'http://127.0.0.1:8792/';
const password = `test-${randomBytes(16).toString('hex')}`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const pages = [await browser.newPage({viewport:{width:390,height:844}}), await browser.newPage({viewport:{width:390,height:844}})];
  const [owner, buddy] = pages;
  const created = [false, false], errors = [];
  pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
  async function signup(page, index) {
    await page.getByRole('button',{name:'创建账号'}).click();
    await page.locator('[name=username]').fill(`ui${randomBytes(8).toString('hex')}`);
    await page.locator('[name=password]').fill(password);
    await page.locator('#auth-form button[type=submit]').click();
    await page.getByRole('heading',{name:'轻食日记'}).waitFor();
    created[index] = true;
  }
  try {
    await owner.goto(base);
    await signup(owner,0);
    assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await owner.getByRole('button',{name:'添加饮食记录'}).click();
    await owner.getByRole('button',{name:/食物库/}).click();
    await owner.locator('#food-search').fill('白米');
    await owner.getByRole('button',{name:/白米饭/}).click();
    await owner.locator('#meal-form [name=grams]').fill('150');
    assert.equal(await owner.locator('#meal-form [name=calories]').inputValue(), '195');
    await owner.getByRole('button',{name:'保存记录'}).click();
    await owner.getByText('白米饭（熟，无盐）').waitFor();
    await owner.getByRole('button',{name:'添加运动'}).first().click();
    await owner.locator('#exercise-form [name=name]').fill('散步');
    await owner.locator('#exercise-form [name=minutes]').fill('30');
    await owner.locator('#exercise-form [name=calories]').fill('120');
    await owner.getByRole('button',{name:'保存运动'}).click();
    await owner.getByText('散步').waitFor();
    assert.equal(await owner.locator('.ring-center strong').textContent(), '1725');

    await owner.locator('.bottom-nav').getByRole('button',{name:'贴纸',exact:true}).click();
    await owner.getByRole('button',{name:'分享这一天'}).click();
    const shareResponse=owner.waitForResponse(r => r.url().endsWith('/api/shares') && r.request().method()==='POST');
    await owner.getByRole('button',{name:/生成 .* 的分享链接/}).click();
    const shareToken=(await (await shareResponse).json()).shares[0].token;
    const visitor=await browser.newPage({viewport:{width:390,height:844}});
    const shareUrl=new URL(base);shareUrl.searchParams.set('share',shareToken);
    await visitor.goto(shareUrl.href);
    await visitor.getByText('白米饭（熟，无盐）').waitFor();
    await owner.getByRole('button',{name:'撤销'}).click();
    await owner.getByText('分享链接已撤销').waitFor();
    await visitor.reload();await visitor.getByText('分享链接无效或已过期').waitFor();
    await visitor.close();await owner.getByRole('button',{name:'关闭'}).click();

    await owner.getByRole('button',{name:'我的',exact:true}).click();
    await owner.getByRole('button',{name:/我的搭子/}).click();
    const inviteResponse=owner.waitForResponse(r => r.url().endsWith('/api/buddy/invites') && r.request().method()==='POST');
    await owner.getByRole('button',{name:'邀请搭子'}).click();
    const inviteToken=(await (await inviteResponse).json()).token;
    const inviteUrl=new URL(base);inviteUrl.searchParams.set('invite',inviteToken);
    await buddy.goto(inviteUrl.href);await signup(buddy,1);
    await buddy.getByRole('heading',{name:'搭子邀请'}).waitFor();
    await buddy.getByRole('button',{name:'接受邀请'}).click();
    await buddy.getByText('白米饭（熟，无盐）').waitFor();
    await owner.reload();await owner.getByRole('button',{name:'我的',exact:true}).click();
    await owner.getByRole('button',{name:/我的搭子/}).click();
    await owner.getByRole('button',{name:'暂停我的共享'}).click();
    await owner.getByText('共享状态已更新').waitFor();
    await buddy.reload();await buddy.getByRole('button',{name:'我的',exact:true}).click();
    await buddy.getByRole('button',{name:/我的搭子/}).click();
    await buddy.getByText('对方已暂停共享').waitFor();
    await buddy.getByRole('button',{name:'解除绑定'}).click();
    await buddy.getByRole('button',{name:'确认解除'}).click();
    await buddy.getByText('还没有绑定搭子').waitFor();

    await owner.getByRole('button',{name:'断食',exact:true}).click();
    await owner.getByRole('button',{name:'开始计时'}).click();
    await owner.getByRole('button',{name:'结束本次计时'}).click();
    await owner.getByRole('button',{name:'结束计时',exact:true}).click();
    await owner.getByText(/实际 00:00/).waitFor();
    assert.deepEqual(errors, []);
    console.log('Mobile browser smoke test passed.');
  } finally {
    for (let i=0; i<pages.length; i++) {
      if (!created[i]) continue;
      const result=await pages[i].evaluate(async pass => {
        const r=await fetch('api/account',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});
        return r.status;
      },password).catch(() => 0);
      if (result!==200) { console.error(`Could not clean up temporary test account ${i}: HTTP ${result}`); process.exitCode=1; }
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode=1; });

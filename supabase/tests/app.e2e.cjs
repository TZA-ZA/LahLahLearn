// End-to-end: the real app against the local Supabase stack.
const {chromium}=require('playwright');
const {execSync}=require('child_process');
const SHOT=require('os').tmpdir()+'/lll-';
const URL='http://127.0.0.1:8768/index.html';
const GW='http://127.0.0.1:54321';
const sql=q=>execSync(`psql -h /tmp -p 54329 -U postgres -d lll_e2e -At -c "${q.replace(/"/g,'\\"')}"`).toString().trim();
const calls=async()=>(await (await fetch(GW+'/__calls')).json()).map(c=>({...c,service:/stripe/.test(c.url)?'stripe':/resend/.test(c.url)?'resend':/anthropic/.test(c.url)?'anthropic':'other',path:c.url}));
let ok=0,fail=0;const check=(n,c,extra='')=>{if(c){ok++;console.log('ok  ',n)}else{fail++;console.log('FAIL',n,extra)}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const PW='Calm-pass-2026';
async function login(p,email,reg,hash,pw=PW){
  await p.goto(URL+(hash||('#auth-'+(reg?'register':'login'))));await p.waitForTimeout(1800);
  await p.fill('#aEm',email);await p.fill('#aPw',pw);if(reg)await p.fill('#aPw2',pw);
  await p.$eval('#aGo',e=>e.click());
  if(reg){await p.waitForSelector('#aCode',{timeout:15000});await p.fill('#aCode','123456')}
  await p.waitForTimeout(4000);
}
async function onboard(p,first){
  if(await p.$('#pkGo')){await p.$eval('#pkGo',e=>e.click());await p.waitForTimeout(900)}
  await p.waitForSelector('#obFirst',{timeout:15000});
  await p.fill('#obFirst',first);await p.fill('#obLast','Test');await p.$eval('#obNext',e=>e.click());await p.waitForTimeout(600);
  for(let i=0;i<25;i++){if(await p.$('#obGo'))break;const nx=await p.$('#obSkip');if(nx&&await nx.isVisible())await nx.click();else{const n2=await p.$('#obNext');if(n2)await n2.click()}await p.waitForTimeout(450)}
  await p.waitForTimeout(3500);await p.$eval('#obGo',e=>e.click());await p.waitForTimeout(2500);
}
async function unlockCare(p,name){
  await p.goto(URL+'#care');await p.waitForTimeout(2200);
  if(await p.$('#cgn')){await p.fill('#cgn',name);await p.fill('#cgp1','1234');await p.fill('#cgp2','1234');await p.$eval('#cgc',e=>e.click());await p.waitForTimeout(900);await p.$eval('#cgok',e=>e.click());await p.waitForTimeout(1500);return}
  if(await p.$('#cgp')){for(const k of '1234'){await p.$eval(`#cgp [data-k="${k}"]`,e=>e.click());await p.waitForTimeout(120)}await p.waitForTimeout(1800)}
}
const tab=async(p,k)=>{await p.evaluate(k=>document.querySelector(`.cc-tabs [data-k="${k}"]`).click(),k);await p.waitForTimeout(1200)};
(async()=>{
  await fetch(GW+'/__reset_calls');
  const b=await chromium.launch();
  const mk=async()=>{const c=await b.newContext({viewport:{width:1280,height:900}});const p=await c.newPage();p.errs=[];p.on('pageerror',e=>p.errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource|dns|ERR_/.test(m.text()))p.errs.push('console: '+m.text())});p.on('dialog',d=>d.dismiss());return [c,p]};

  console.log('--- 1. parent registers');
  const [c1,p]=await mk();
  await login(p,'amina.e2e@gmail.com',true);
  await onboard(p,'Aisha');
  if(await p.$('#cgn')){ // device PIN gate offered after onboarding
    check('device PIN gate hides role + email in cloud mode',await p.evaluate(()=>document.querySelector('#cgr').hidden&&document.querySelector('#cge').closest('label').hidden));
    await p.fill('#cgn','Amina');await p.fill('#cgp1','1234');await p.fill('#cgp2','1234');await p.$eval('#cgc',e=>e.click());await p.waitForTimeout(900);await p.$eval('#cgok',e=>e.click());await p.waitForTimeout(1500);
  }
  await p.screenshot({path:SHOT+'1_after_onboard.png'});
  console.log('hash:',await p.evaluate(()=>location.hash));
  await wait(2500);
  const fam=sql("select id from families where owner_id=(select id from auth.users where email='amina.e2e@gmail.com')");
  check('family created',!!fam);
  check('child saved to cloud',sql(`select profile->>'name' from children where family_id='${fam}'`).includes('Aisha'));
  check('progress row saved',sql(`select count(*) from progress where family_id='${fam}'`)==='1');
  check('kids list saved on family',sql(`select jsonb_array_length(kids_meta->'list') from families where id='${fam}'`)==='1');
  check('no page errors (parent)',p.errs.length===0,JSON.stringify(p.errs));
  await c1.close();

  console.log('--- 2. new device, log in, data comes back');
  sql(`update progress set data=jsonb_set(data,'{pts}','7') where family_id='${fam}'`);
  const [c2,p2]=await mk();
  await login(p2,'amina.e2e@gmail.com',false);await p2.waitForTimeout(2000);
  console.log('hash:',await p2.evaluate(()=>location.hash));
  const lp=await p2.evaluate(()=>{try{return{pr:JSON.parse(localStorage.getItem('ll1.profile')),pg:JSON.parse(localStorage.getItem('ll1.progress'))}}catch(e){return{}}});
  check('profile restored on new device',lp.pr&&/Aisha/.test(lp.pr.name),JSON.stringify(lp.pr&&lp.pr.name));
  check('progress restored (pts=7)',lp.pg&&lp.pg.pts===7,JSON.stringify(lp.pg&&lp.pg.pts));
  await p2.screenshot({path:SHOT+'2_relogin.png'});
  console.log('--- 2b. password checks');
  {const [cx,px]=await mk();
   await px.goto(URL+'#auth-login');await px.waitForTimeout(1500);
   await px.fill('#aEm','amina.e2e@gmail.com');await px.fill('#aPw','wrong-password');await px.$eval('#aGo',e=>e.click());await px.waitForTimeout(1500);
   check('wrong password is refused',/not right/i.test(await px.textContent('#aPwErr'))&&/auth-login/.test(px.url()),await px.textContent('#aPwErr'));
   await px.$eval('#aForgot',e=>e.click());await px.waitForSelector('#aCode');await px.fill('#aCode','123456');await px.waitForSelector('#aNp');
   await px.fill('#aNp','New-calm-2026');await px.fill('#aNp2','New-calm-2026');await px.$eval('#aNpGo',e=>e.click());await px.waitForTimeout(3500);
   check('forgot password: new password saved and signed in',/dashboard|who/.test(px.url()),px.url());
   await cx.close();
   const [cy,py]=await mk();await login(py,'amina.e2e@gmail.com',false,null,'New-calm-2026');
   check('logs in with the new password',/dashboard|who/.test(py.url()),py.url());
   const [cz,pz]=await mk();await login(pz,'amina.e2e@gmail.com',false,null,PW);
   check('old password no longer works',/auth-login/.test(pz.url()),pz.url());
   await cy.close();await cz.close();
   const [cr,pr]=await mk();await pr.goto(URL+'#auth-register');await pr.waitForTimeout(1500);
   await pr.fill('#aEm','amina.e2e@gmail.com');await pr.fill('#aPw','Another-2026');await pr.fill('#aPw2','Another-2026');await pr.$eval('#aGo',e=>e.click());await pr.waitForTimeout(1500);
   check('registering an existing email is refused',/already an account/i.test(await pr.textContent('#aEmErr')),await pr.textContent('#aEmErr'));
   await pr.fill('#aEm','new.person.e2e@gmail.com');await pr.fill('#aPw','short');await pr.fill('#aPw2','short');await pr.$eval('#aGo',e=>e.click());await pr.waitForTimeout(800);
   check('short password refused',/at least 8/i.test(await pr.textContent('#aPwErr')));
   await pr.fill('#aPw','Calm-pass-2026');await pr.fill('#aPw2','Calm-pass-2027');await pr.$eval('#aGo',e=>e.click());await pr.waitForTimeout(800);
   check('mismatched passwords refused',/not the same/i.test(await pr.textContent('#aPwErr')));
   await cr.close();}

  console.log('--- 3. invite a teacher and a therapist');
  await unlockCare(p2,'Amina');
  await p2.screenshot({path:SHOT+'3_care.png'});
  await tab(p2,'team');
  await p2.fill('#tmn','Ms Lim');
  await p2.$eval('#tmr [data-r="teacher"]',e=>e.click());
  await p2.fill('#tme','lim.teacher.e2e@gmail.com');
  await p2.$eval('#tmadd',e=>e.click());await p2.waitForTimeout(3000);
  console.log('invite msg:',await p2.textContent('#tmm'));
  const tTok=sql(`select token from invites where email='lim.teacher.e2e@gmail.com'`);
  check('teacher invite stored',!!tTok);
  await p2.fill('#tmn','Dr Raj');await p2.$eval('#tmr [data-r="therapist"]',e=>e.click());await p2.fill('#tme','raj.therapist.e2e@gmail.com');
  await p2.$eval('#tmadd',e=>e.click());await p2.waitForTimeout(3000);
  const rTok=sql(`select token from invites where email='raj.therapist.e2e@gmail.com'`);
  check('therapist invite stored',!!rTok);
  check('invite emails sent',(await calls()).filter(c=>c.service==='resend').length>=2,JSON.stringify((await calls()).map(c=>c.service)));
  await p2.evaluate(()=>{});await tab(p2,'overview');await tab(p2,'team');
  check('pending invites listed',(await p2.$$('[data-rminv]')).length===2);
  await p2.screenshot({path:SHOT+'4_team.png',fullPage:true});

  console.log('--- 4. teacher joins from the link');
  const [c3,t]=await mk();
  await t.goto(URL+'#join-'+tTok);await t.waitForTimeout(2000);
  console.log('teacher hash after link:',await t.evaluate(()=>location.hash));
  await t.fill('#aEm','lim.teacher.e2e@gmail.com');await t.fill('#aPw',PW);await t.fill('#aPw2',PW);await t.$eval('#aGo',e=>e.click());await t.waitForSelector('#aCode');await t.fill('#aCode','123456');await t.waitForTimeout(5000);
  console.log('teacher hash after login:',await t.evaluate(()=>location.hash));
  check('teacher is a member',sql(`select role from family_members where family_id='${fam}' and email='lim.teacher.e2e@gmail.com'`)==='teacher');
  await t.screenshot({path:SHOT+'5_teacher.png'});
  if(await t.$('[data-hk]')){await t.$eval('[data-hk]',e=>e.click());await t.waitForTimeout(3000)}
  console.log('teacher hash after opening child:',await t.evaluate(()=>location.hash));
  await t.screenshot({path:SHOT+'6_teacher_child.png'});
  const tText=await t.evaluate(()=>document.body.innerText);
  check('teacher sees the child',/Aisha/.test(tText));
  check('teacher created no family of their own',sql(`select count(*) from families where owner_id=(select id from auth.users where email='lim.teacher.e2e@gmail.com')`)==='0');
  check('no page errors (teacher)',t.errs.length===0,JSON.stringify(t.errs));

  console.log('--- 5. therapist joins and shares times');
  const [c4,r]=await mk();
  await login(r,'raj.therapist.e2e@gmail.com',true,'#join-'+rTok);
  if(await r.$('[data-hk]')){await r.$eval('[data-hk]',e=>e.click());await r.waitForTimeout(3000)}
  console.log('therapist hash:',await r.evaluate(()=>location.hash));
  if(!(await r.$('.cc-tabs')))await unlockCare(r,'Dr Raj');
  if(await r.$('.cc-tabs')){await tab(r,'visits');
    const sl=await r.$$('[data-sl]');for(const s of sl.slice(0,3)){await s.evaluate(e=>e.click());await r.waitForTimeout(300)}await r.waitForTimeout(1500);}
  await r.screenshot({path:SHOT+'7_therapist.png',fullPage:true});
  check('therapist availability saved',+sql(`select coalesce(array_length(availability,1),0) from family_members where email='raj.therapist.e2e@gmail.com'`)>=3,sql(`select availability from family_members where email='raj.therapist.e2e@gmail.com'`));
  check('no page errors (therapist)',r.errs.length===0,JSON.stringify(r.errs));

  console.log('--- 6. parent books a check-up');
  await fetch(GW+'/__reset_calls');
  await p2.reload();await p2.waitForTimeout(2500);await unlockCare(p2,'Amina');await tab(p2,'visits');await p2.waitForTimeout(800);
  const opts=await p2.$$eval('#vwho option',o=>o.map(x=>x.value+'|'+x.textContent));console.log('therapists:',opts);
  if(await p2.$('#vts')){await p2.$eval('#vbook',e=>e.click());}
  else{await p2.selectOption('#vwho','x');await p2.fill('#vxn','Dr Other');await p2.fill('#vxt',new Date(Date.now()+3*864e5).toISOString().slice(0,16));await p2.$eval('#vbook',e=>e.click())}
  await p2.waitForTimeout(3500);
  check('appointment stored',sql(`select count(*) from appointments where family_id='${fam}' and status='booked'`)==='1');
  check('check-up emails sent',(await calls()).some(c=>c.service==='resend'),JSON.stringify(await calls()));
  check('booked check-up listed',(await p2.$$('[data-cx]')).length===1);
  await p2.screenshot({path:SHOT+'8_visits.png',fullPage:true});

  console.log('--- 7. weekly report by email');
  await fetch(GW+'/__reset_calls');
  await tab(p2,'report');
  if(await p2.$('#wre')){await p2.fill('#wre','amina.e2e@gmail.com');await p2.$eval('#wrs',e=>e.click());await p2.waitForTimeout(3500);console.log('report msg:',await p2.textContent('#wrm'))}
  check('weekly report emailed',(await calls()).some(c=>c.service==='resend'));
  await p2.screenshot({path:SHOT+'9_report.png',fullPage:true});

  console.log('--- 8. plans: trial then checkout');
  await p2.goto(URL+'#pricing');await p2.waitForTimeout(2500);
  const famBtn=await p2.$('[data-plan="family"]');console.log('family CTA:',famBtn&&await famBtn.innerText());
  await famBtn.evaluate(e=>e.click());await p2.waitForTimeout(3000);
  check('trial started in DB',sql(`select trial_started_at is not null from families where id='${fam}'`)==='t');
  await p2.goto(URL+'#pricing');await p2.waitForTimeout(2500);
  console.log('family CTA now:',await (await p2.$('[data-plan="family"]')).innerText());
  await p2.screenshot({path:SHOT+'10_pricing_trial.png'});
  await fetch(GW+'/__reset_calls');
  // During a trial the button says Subscribe -> Checkout
  const nav=p2.waitForEvent('framenavigated',{timeout:8000}).catch(()=>null);
  await p2.$eval('[data-plan="family"]',e=>e.click());await p2.waitForTimeout(3000);
  const st=(await calls()).filter(c=>c.service==='stripe');console.log('stripe calls:',st.map(c=>c.path));
  check('checkout session created',st.some(c=>/checkout\/sessions/.test(c.path)));
  console.log('url after checkout click:',p2.url());

  console.log('--- 9. Pip chat');
  await fetch(GW+'/__reset_calls');
  await p2.goto(URL+'#study');await p2.waitForTimeout(2500);
  if(await p2.$('#tpin')){await p2.fill('#tpin','Why is the sky blue?');await p2.$eval('#tpgo',e=>e.click());await p2.waitForTimeout(3500)}
  const an=(await calls()).filter(c=>c.service==='anthropic');
  check('Pip asked the AI through the server',an.length===1,JSON.stringify(await calls()));
  console.log('pip said:',await p2.evaluate(()=>[...document.querySelectorAll('.tpb.pip')].map(x=>x.textContent).slice(-1)[0]));
  check('no page errors (parent, device 2)',p2.errs.length===0,JSON.stringify(p2.errs));

  await b.close();
  console.log(`${ok} passed, ${fail} failed`);
})().catch(e=>{console.error(e);process.exit(1)});

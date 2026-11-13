#!/usr/bin/env node
/* Pre-renders the public pages to plain HTML so search engines and AI assistants can read them without running the app.
   Run from the repo root after changing the legal text or FAQ in index.html:   node scripts/build-pages.cjs
   Needs Playwright (npm i -D playwright). Writes about/, contact/, privacy/, terms/, refunds/, cookies/, thank-you/, 404.html,
   sitemap.xml and llms.txt. */
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://lahlahlearn.com';
const MAIL = 'lahlahlearn@gmail.com';
const TODAY = new Date().toISOString().slice(0, 10);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
@font-face{font-family:'Fredoka';font-style:normal;font-weight:300 700;font-display:swap;src:url(BASEassets/fonts/fredoka.woff2) format('woff2')}
@font-face{font-family:'Lexend';font-style:normal;font-weight:400;font-display:swap;src:url(BASEassets/fonts/lexend-latin-400-normal.woff2) format('woff2')}
@font-face{font-family:'Lexend';font-style:normal;font-weight:600;font-display:swap;src:url(BASEassets/fonts/lexend-latin-600-normal.woff2) format('woff2')}
:root{--bg:#f6f8f2;--surf:#fffdf9;--ink:#1c2520;--muted:#55605a;--brand:#1f6b4a;--line:#dfe5da;--sun:#f0c24b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#121a16;--surf:#1a241f;--ink:#eef3ee;--muted:#b3beb7;--brand:#7fd6a6;--line:#2c3a33}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.65 Lexend,system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:var(--brand);text-underline-offset:3px}a:focus-visible,button:focus-visible{outline:3px solid var(--sun);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surf);padding:8px 14px;border-radius:10px;z-index:9}.skip:focus{left:8px}
.top{background:var(--surf);border-bottom:1px solid var(--line)}
.top .in{max-width:980px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.top img{display:block;height:44px;width:auto}
.top nav{display:flex;gap:6px 18px;flex-wrap:wrap;align-items:center;font-weight:600;font-size:.95rem}
.top nav a{text-decoration:none;color:var(--ink);padding:6px 2px}.top nav a:hover{color:var(--brand)}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border-radius:999px;background:var(--brand);color:#fff!important;font-weight:600;text-decoration:none}
@media (prefers-color-scheme:dark){.cta{color:#0f1a14!important}}
main{max-width:820px;margin:0 auto;padding:34px 20px 60px}
h1{font:600 clamp(2rem,5vw,2.8rem)/1.15 Fredoka,Lexend,sans-serif;margin:.2em 0 .35em}
h2{font:600 1.45rem/1.25 Fredoka,Lexend,sans-serif;margin:1.9em 0 .4em}h3{font:600 1.1rem/1.3 Lexend,sans-serif;margin:1.3em 0 .3em}
p,li{max-width:70ch}ul,ol{padding-left:1.3em}li{margin:.3em 0}
.eb{font-weight:600;color:var(--brand);margin:0}.lead{font-size:1.15rem;color:var(--muted)}.dt{color:var(--muted);font-size:.95rem}
.card{background:var(--surf);border:1px solid var(--line);border-radius:18px;padding:20px 22px;margin:18px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:16px 0}.grid .card{margin:0}
.pv-tw{overflow-x:auto;margin:14px 0}table{border-collapse:collapse;width:100%;font-size:.93rem}th,td{border:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:top}th{background:var(--surf)}
.team{list-style:none;padding:0;margin:18px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}.team li{margin:0;max-width:none;background:var(--surf);border:1px solid var(--line);border-radius:18px;padding:18px 12px;display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}.team img{width:104px;height:104px;border-radius:50%;object-fit:cover;margin-bottom:6px}.team span{color:var(--muted);font-size:.93rem}.team .tl{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:4px}
details{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin:10px 0}summary{font-weight:600;cursor:pointer}
.hero{display:flex;gap:26px;align-items:center;flex-wrap:wrap}.hero img{width:min(300px,70vw);height:auto}
footer{border-top:1px solid var(--line);background:var(--surf)}
footer .in{max-width:980px;margin:0 auto;padding:24px 20px 96px;display:flex;gap:10px 22px;flex-wrap:wrap;font-size:.92rem;align-items:center}
footer a{color:var(--ink)}footer .cp{margin-left:auto;color:var(--muted)}
.sticky{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));background:var(--surf);border-top:1px solid var(--line);display:none;z-index:8}
.sticky .cta{width:100%}
@media (max-width:640px){.sticky{display:block}.top .cta{display:none}body{font-size:16px}}
@media (min-width:641px){footer .in{padding-bottom:24px}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

function page({ slug, title, desc, h1, body, base = '../', noindex = false, jsonld = [], cta = true, abs = false }) {
  const B = abs ? SITE + '/' : base;
  const url = slug === '404' ? SITE + '/' : `${SITE}/${slug}/`;
  const nav = [['about/', 'About'], ['#pricing', 'Plans'], ['contact/', 'Contact']];
  const foot = [['about/', 'About'], ['contact/', 'Contact'], ['terms/', 'Terms of service'], ['privacy/', 'Privacy policy'], ['refunds/', 'Refund policy'], ['cookies/', 'Cookie policy']];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : `<link rel="canonical" href="${url}">\n<meta name="robots" content="index,follow">`}
<meta name="theme-color" content="#e8f6ee">
<meta property="og:type" content="website"><meta property="og:site_name" content="LahLahLearn">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}"><meta property="og:image" content="${SITE}/assets/img/share.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${B}favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="48x48" href="${B}favicon-48.png"><link rel="apple-touch-icon" href="${B}icon-192.png">
<link rel="preload" href="${B}assets/fonts/fredoka.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS.replace(/BASE/g, B).replace(/\n/g, '')}</style>
${jsonld.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="top"><div class="in"><a href="${B}" aria-label="LahLahLearn home"><img src="${B}assets/img/logo.webp" alt="LahLahLearn" width="150" height="72"></a>
<nav aria-label="Main">${nav.map(([h, t]) => `<a href="${B}${h}">${t}</a>`).join('')}${cta ? `<a class="cta" href="${B}#auth-register">Start free</a>` : ''}</nav></div></header>
<main id="main">
<h1>${h1}</h1>
${body}
</main>
<footer><div class="in">${foot.map(([h, t]) => `<a href="${B}${h}">${t}</a>`).join('')}<a href="mailto:${MAIL}">${MAIL}</a><span class="cp">&copy; ${new Date().getFullYear()} LahLahLearn. Selangor, Malaysia.</span></div></footer>
${cta ? `<div class="sticky"><a class="cta" href="${B}#auth-register">Start free</a></div>` : ''}
</body>
</html>
`;
}

(async () => {
  // a tiny local server, so the build is offline and independent of the live backend (config.js is served with the cloud switched off)
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg' };
  const srv = require('http').createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/assets/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.LLL_CONFIG={supabaseUrl:''};"); }
    const f = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('lll.consent', 'essential'); } catch (e) { } });
  await ctx.route(u => !/^http:\/\/127\.0\.0\.1/.test(String(u)), r => r.abort());
  const p = await ctx.newPage();
  const file = `http://127.0.0.1:${srv.address().port}/`;
  const out = (rel, html) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); console.log('wrote', rel, html.length); };

  async function legal(route) {
    await p.goto(file + '#' + route); await p.reload(); await p.waitForSelector('.pv-body', { timeout: 15000 });
    return p.evaluate(() => {
      const date = (document.querySelector('.pv-dt') || {}).textContent || '';
      const note = (document.querySelector('.pv-note') || {}).textContent || '';
      const body = document.querySelector('.pv-body').cloneNode(true);
      body.querySelectorAll('[data-cookies]').forEach(x => { const a = document.createElement('a'); a.href = '../#cookies'; a.textContent = 'Cookie settings'; x.replaceWith(a); });
      body.querySelectorAll('a[href^="#"]').forEach(a => { const h = a.getAttribute('href').slice(1); a.setAttribute('href', ['privacy', 'terms', 'refunds', 'cookies'].includes(h) ? '../' + h + '/' : '../#' + h); });
      body.querySelectorAll('[class]').forEach(e => { if (!/^pv-(tw|ad)$/.test(e.className)) e.removeAttribute('class'); });
      body.querySelectorAll('[id],[style]').forEach(e => { e.removeAttribute('id'); e.removeAttribute('style'); });
      return { date, note, html: body.innerHTML };
    });
  }
  const LEGAL = [
    ['privacy', 'Privacy Policy', 'How LahLahLearn collects, uses and protects personal data, including children’s data, under Malaysia’s PDPA.'],
    ['terms', 'Terms of Service', 'The agreement for using LahLahLearn: accounts, plans, the free trial, payment, acceptable use and your rights.'],
    ['refunds', 'Refund Policy', 'How cancelling a LahLahLearn plan works, when refunds apply, and what to do if you were charged in error.'],
    ['cookies', 'Cookie Policy', 'The cookies and browser storage LahLahLearn uses. No advertising or tracking cookies, and how to change your choice.'],
  ];
  for (const [slug, name, desc] of LEGAL) {
    const L = await legal(slug);
    out(`${slug}/index.html`, page({ slug, title: `${name} - LahLahLearn`, desc, h1: name, cta: false,
      body: `<p class="dt">${esc(L.date)}</p>${L.note ? `<p class="lead">${esc(L.note)}</p>` : ''}\n${L.html}`,
      jsonld: [{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'LahLahLearn', item: SITE + '/' }, { '@type': 'ListItem', position: 2, name, item: `${SITE}/${slug}/` }] }] }));
  }

  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fa = src.indexOf('const FAQ=['), fb = src.indexOf(']];', fa);
  const FAQ = new Function('return ' + src.slice(fa + 'const FAQ='.length, fb + 2))();
  await b.close(); srv.close();

  const ta = src.indexOf('const TEAM=['), tb = src.indexOf(']];', ta);
  const TEAM = new Function('return ' + src.slice(ta + 'const TEAM='.length, tb + 2))();
  const teamHtml = '<ul class="team">' + TEAM.map(m => `<li><img src="../assets/team/${m[0]}.webp" alt="${esc(m[1])}" width="120" height="120" loading="lazy"><b>${esc(m[1])}</b><span>${esc(m[2])}</span><span class="tl">${m[3] ? `<a href="https://www.instagram.com/${m[3]}/" rel="noopener">Instagram</a>` : ''}${m[4] ? `<a href="https://www.linkedin.com/in/${m[4]}/" rel="noopener">LinkedIn</a>` : ''}</span></li>`).join('') + '</ul>';
  const faqHtml = FAQ.map(f => `<details><summary>${esc(f[0])}</summary><p>${esc(f[1])}</p></details>`).join('\n');
  out('about/index.html', page({
    slug: 'about', title: 'About LahLahLearn - Calm learning app for children aged 3 to 8',
    desc: 'LahLahLearn is a calm, playful learning app for children aged 3 to 8, with short lessons, a friendly guide called Pip and a Care Circle for parents, teachers and therapists.',
    h1: 'About LahLahLearn',
    body: `<div class="hero"><div style="flex:1 1 320px"><p class="lead">LahLahLearn is a calm, playful learning app for children aged 3 to 8. Lessons are short, the screen stays quiet, and every child moves at their own pace.</p>
<p><a class="cta" href="../#auth-register">Start free</a> &nbsp; <a href="../#pricing">See plans</a></p></div>
<img src="../assets/img/logo-full.webp" alt="LahLahLearn logo with three friendly characters: a leafy bunny, a cloud bunny and a little fox" width="900" height="427"></div>

<h2>What LahLahLearn is</h2>
<p>LahLahLearn is a web app that runs in the browser on a computer, tablet or phone. A grown-up sets it up in a few minutes by answering gentle, everyday questions about the child. The app then adjusts its fonts, sounds, motion and lesson length to match.</p>
<p>Children learn reading, maths, feelings and everyday life skills with Pip, a friendly guide. Lessons take three to five minutes, show at most three choices at a time, and give only kind feedback. There are no failure screens and no red crosses.</p>

<h2>Who it is for</h2>
<p>LahLahLearn is made for children who learn best with short lessons, calm screens and a flexible pace. That includes children who learn differently, and children who are deaf or hard of hearing. It is used at home with a parent or guardian, and it can be shared with the teachers and therapists who support the child.</p>

<h2>How it works</h2>
<ol><li><b>A short set-up.</b> A grown-up answers about 12 gentle questions. The child never takes a test.</li>
<li><b>Learn in calm bursts.</b> Three to five minutes at a time, with stars for effort, never scores.</li>
<li><b>Share progress.</b> The Care Circle shows parents, teachers and therapists the same goals and progress.</li></ol>

<h2>What is inside</h2>
<div class="grid">
<div class="card"><h3>Lessons in order</h3><p>A step-by-step journey through classes. Each lesson opens the next, and a small test opens the next class.</p></div>
<div class="card"><h3>Pip, a friendly guide</h3><p>Pip reads aloud, cheers gently and can chat with the child in a safe, age-appropriate way.</p></div>
<div class="card"><h3>Calm breaks</h3><p>Breathing and quiet moments whenever a child needs one. Everything pauses until they are ready.</p></div>
<div class="card"><h3>Stories and songs</h3><p>Picture books that read aloud, sing-along songs, drawing, tracing letters and movement games.</p></div>
<div class="card"><h3>A small 3D world</h3><p>An island to walk around, with places to play and things to decorate with rewards from lessons.</p></div>
<div class="card"><h3>Care Circle</h3><p>One calm view of progress for the grown-ups, with weekly reports by email.</p></div>
</div>

<h2>Plans</h2>
<p>There is a Free plan, a paid Family plan with a 7-day free trial that needs no payment details, and a School or clinic plan. Prices are shown in your currency on the <a href="../#pricing">Plans</a> page. You can cancel a paid plan at any time; see the <a href="../refunds/">Refund Policy</a>.</p>

<h2>Safety and privacy</h2>
<ul><li>Accounts are created by a parent or guardian aged 18 or over, who gives consent for the child.</li>
<li>Children are never asked for an email address, phone number or home address, and children never chat with each other.</li>
<li>No advertising, and no advertising or tracking cookies.</li>
<li>A parent can delete the account and all of the child&rsquo;s data at any time in Settings. A code is emailed to the parent first, to check it is really them.</li></ul>
<p>Read the full <a href="../privacy/">Privacy Policy</a> and <a href="../terms/">Terms of Service</a>.</p>
<p>LahLahLearn supports learning at home. It does not diagnose or treat any condition and does not replace school, therapy or professional advice.</p>

<h2 id="team">Behind the scenes: who makes it</h2>
<p>LahLahLearn is made in Selangor, Malaysia, by a small student team at Sunway University. You can reach us at <a href="mailto:${MAIL}">${MAIL}</a> or on the <a href="../contact/">Contact</a> page.</p>
${teamHtml}

<h2>Good questions</h2>
${faqHtml}

<h2>Credits and licences</h2>
<ul><li>Fonts: Fredoka, Lexend and Patrick Hand, each under the SIL Open Font License 1.1.</li>
<li>Some pictures are adapted from <a href="https://openmoji.org/" rel="noopener">OpenMoji</a>, licensed CC BY-SA 4.0. The adapted pictures are shared under the same licence.</li>
<li>The app uses the open-source libraries supabase-js and three.js, both under the MIT License.</li>
<li>The official Global Goals names and logos belong to the United Nations. Our goal tiles use our own colours.</li></ul>`,
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'LahLahLearn', url: SITE + '/', logo: SITE + '/icon-512.png', email: MAIL, address: { '@type': 'PostalAddress', addressRegion: 'Selangor', addressCountry: 'MY' } },
      { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'LahLahLearn', url: SITE + '/', applicationCategory: 'EducationalApplication', operatingSystem: 'Any (web browser)', audience: { '@type': 'PeopleAudience', suggestedMinAge: 3, suggestedMaxAge: 8 }, description: 'A calm, playful learning app for children aged 3 to 8: reading, maths, feelings and life skills with Pip, a friendly guide.', offers: { '@type': 'Offer', price: '0', priceCurrency: 'MYR', description: 'Free plan' } },
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(f => ({ '@type': 'Question', name: f[0], acceptedAnswer: { '@type': 'Answer', text: f[1] } })) },
    ] }));

  out('contact/index.html', page({
    slug: 'contact', title: 'Contact LahLahLearn', desc: 'How to contact LahLahLearn for help, questions about a charge, privacy requests or to delete your data.',
    h1: 'Contact us',
    body: `<p class="lead">Questions or ideas? We would love to hear from you.</p>
<div class="card"><h2 style="margin-top:0">Email</h2><p><a href="mailto:${MAIL}">${MAIL}</a></p><p>LahLahLearn<br>Selangor, Malaysia</p></div>
<h2>What to include</h2>
<ul><li>The email address of your account, if you have one.</li><li>What you were trying to do and what happened.</li><li>For a charge: the date and the amount.</li></ul>
<p>Please do not send passwords, card numbers or your parent PIN. We will never ask for them.</p>
<h2>Privacy and data requests</h2>
<p>You can ask to see, correct or delete the personal data we hold about you or your child. A parent can also delete the whole account at any time in the app: <b>Settings &rarr; Account &rarr; Delete account</b>. We email a code to check it is really you, then the family&rsquo;s profiles, learning records and Care Circle data are removed. See the <a href="../privacy/">Privacy Policy</a>.</p>
<h2>Billing</h2>
<p>You can cancel a paid plan at any time from the Plans page. For anything else about a charge, see the <a href="../refunds/">Refund Policy</a> or email us.</p>`,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'ContactPage', name: 'Contact LahLahLearn', url: SITE + '/contact/', mainEntity: { '@type': 'Organization', name: 'LahLahLearn', email: MAIL, url: SITE + '/' } }] }));

  out('thank-you/index.html', page({
    slug: 'thank-you', title: 'Thank you - LahLahLearn', desc: 'Thank you from LahLahLearn.', h1: 'Thank you!', noindex: true, cta: false,
    body: `<p class="lead">You are all set. Thank you for being part of LahLahLearn.</p><p><a class="cta" href="../">Back to LahLahLearn</a></p><p>Need anything? Write to <a href="mailto:${MAIL}">${MAIL}</a>.</p>` }));

  out('404.html', page({
    slug: '404', title: 'Page not found - LahLahLearn', desc: 'This page could not be found.', h1: 'We could not find that page', noindex: true, abs: true,
    body: `<div class="hero"><img src="${SITE}/assets/img/pip-hello.webp" alt="Pip, the leafy bunny, waving hello" width="220" height="220" style="width:180px"><div style="flex:1 1 280px"><p class="lead">The page may have moved, or the link may have a small mistake in it. Pip can take you somewhere useful.</p>
<p><a class="cta" href="${SITE}/">Go to the home page</a></p></div></div>
<h2>Popular pages</h2>
<ul><li><a href="${SITE}/about/">About LahLahLearn</a></li><li><a href="${SITE}/#pricing">Plans</a></li><li><a href="${SITE}/#auth-login">Log in</a></li><li><a href="${SITE}/contact/">Contact us</a></li></ul>` }));

  const urls = [['', '1.0'], ['about/', '0.8'], ['contact/', '0.5'], ['privacy/', '0.3'], ['terms/', '0.3'], ['refunds/', '0.3'], ['cookies/', '0.3']];
  out('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, pr]) => `  <url><loc>${SITE}/${u}</loc><lastmod>${TODAY}</lastmod><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`);

  out('llms.txt', `# LahLahLearn

> LahLahLearn is a calm, playful web learning app for children aged 3 to 8. Short 3 to 5 minute lessons cover reading, maths, feelings and life skills, guided by Pip, a friendly character. Parents, teachers and therapists follow progress together in the Care Circle. Made in Selangor, Malaysia.

Key facts:
- Runs in the browser on computers, tablets and phones at ${SITE}/
- For children who learn best with short lessons, calm screens and a flexible pace
- Accounts are created by a parent or guardian aged 18 or over; children are never asked for contact details and never chat with each other
- No advertising and no tracking cookies
- Free plan, a paid Family plan with a 7-day free trial (no payment details needed), and a School or clinic plan
- It supports learning at home; it does not diagnose or treat any condition
- Contact: ${MAIL}

## Pages
- [About LahLahLearn](${SITE}/about/): what it is, who it is for, how it works, FAQ, credits
- [Contact](${SITE}/contact/): email, privacy and data requests, billing help
- [Privacy Policy](${SITE}/privacy/)
- [Terms of Service](${SITE}/terms/)
- [Refund Policy](${SITE}/refunds/)
- [Cookie Policy](${SITE}/cookies/)
`);
})().catch(e => { console.error(e); process.exit(1); });

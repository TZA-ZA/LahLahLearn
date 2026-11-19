/* LahLahLearn service worker: only shows alerts for grown-ups and opens the app when one is tapped.
   It does not cache pages and never sees camera or chat data. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#care';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { try { c.navigate(url); } catch (err) { /* same page */ } return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

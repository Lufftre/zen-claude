const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await browser.runtime.sendMessage({ type: 'getState' });
  $('enabled').checked = s.enabled;
  $('trusted').checked = s.trustedEnabled && s.trustedAvailable;
  $('trusted').disabled = !s.trustedAvailable;
  $('trustedNote').textContent = s.trustedAvailable ? '(browser-level events)' : '(not available in this browser)';
  if (document.activeElement !== $('port')) $('port').value = s.port;
  $('dot').className = `dot ${!s.enabled ? '' : s.connected ? 'ok' : 'bad'}`;
  $('status').textContent = s.status[0].toUpperCase() + s.status.slice(1);
  $('hint').hidden = !s.enabled || s.connected;
  const list = $('activity');
  list.replaceChildren();
  if (!s.activity.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tool calls yet.';
    list.append(li);
  }
  for (const a of s.activity) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(a.time).toLocaleTimeString();
    const text = document.createElement('span');
    text.textContent = `${a.ok === false ? '✗' : a.ok ? '✓' : '…'} ${a.method} ${a.summary}`;
    if (a.ok === false) { text.className = 'err'; text.title = a.error; }
    li.append(time, text);
    list.append(li);
  }
}

$('enabled').addEventListener('change', async (e) => {
  await browser.runtime.sendMessage({ type: 'setEnabled', enabled: e.target.checked });
  refresh();
});
$('trusted').addEventListener('change', async (e) => {
  await browser.runtime.sendMessage({ type: 'setTrusted', enabled: e.target.checked });
  refresh();
});
$('port').addEventListener('change', async (e) => {
  await browser.runtime.sendMessage({ type: 'setPort', port: e.target.value });
  refresh();
});

refresh();
setInterval(refresh, 1000);

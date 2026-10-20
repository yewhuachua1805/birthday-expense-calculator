const $ = sel => document.querySelector(sel);
let me = null;
let editingId = null;
let inviteMessage = '';
let lastSummary = null;

// One place to change the currency and locale; used for money, dates and the amount label.
const CURRENCY = 'USD';
const LOCALE = 'en-US';

// ---------- Helpers ----------

const NETWORK_ERROR = 'Can’t reach the app — check you’re on the same Wi-Fi as the computer running it.';

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw Object.assign(new Error(NETWORK_ERROR), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status >= 500 ? `Something went wrong on the server (${res.status}). Please try again.` : 'Request failed';
    throw Object.assign(new Error(data.error || fallback), { status: res.status });
  }
  return data;
}

const money = cents =>
  (cents / 100).toLocaleString(LOCALE, { style: 'currency', currency: CURRENCY });

const escapeHtml = text =>
  String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

const formatDate = iso =>
  new Date(iso + 'T00:00').toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

const isLocalHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const isPrivateNetwork = host => isLocalHost(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);

// Screen readers hear this politely after adds, edits and deletes.
function announce(message) {
  const el = $('#live-status');
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

// navigator.clipboard only works on https or localhost, so fall back to the older copy command.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Copy failed');
  }
}

// ---------- Views ----------

async function boot() {
  $('#loading-message').textContent = 'Loading…';
  $('#boot-retry').hidden = true;
  try {
    me = await api('/api/me');
    showApp();
  } catch (err) {
    if (err.status === 401) return showAuth({ focus: false });
    // Network or server trouble: say so instead of pretending the user is logged out.
    $('#loading-message').textContent = err.message;
    $('#boot-retry').hidden = false;
  }
}

function showAuth({ focus = true } = {}) {
  $('#loading-view').hidden = true;
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  if (focus) $('#auth-heading').focus();
}

async function showApp({ focus = false } = {}) {
  $('#loading-view').hidden = true;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#whoami').innerHTML = `<span class="hi">Hi, </span>${escapeHtml(me.name)}`;
  $('#whoami').title = `Logged in as ${me.name}`;
  document.querySelectorAll('.currency-code').forEach(el => { el.textContent = CURRENCY; });
  resetForm();
  if (focus) $('#app-heading').focus();
  await refresh();
}

// Returns true when the data loaded; on failure shows a banner with a Retry button.
async function refresh() {
  try {
    const [summary, expenses, invite] = await Promise.all([api('/api/summary'), api('/api/expenses'), api('/api/invite')]);
    $('#load-error').hidden = true;
    renderSummary(summary);
    renderInvite(summary, invite);
    renderExpenses(expenses);
    return true;
  } catch (err) {
    if (err.status === 401) { showAuth(); return false; }
    $('#load-error-message').textContent = `Couldn’t load the latest numbers. ${err.message}`;
    $('#load-error').hidden = false;
    return false;
  }
}

function renderInvite(s, invite) {
  const missing = s.maxMembers - s.memberCount;
  $('#invite-card').hidden = missing === 0;
  if (!missing) return;

  // When the app is opened on this computer as "localhost", share the Wi-Fi address instead.
  const link = isLocalHost(location.hostname) && invite.lanUrl ? invite.lanUrl : location.origin;
  $('#invite-status').textContent = `${s.memberCount} of ${s.maxMembers} family members have signed up. ` +
    `${missing === 1 ? '1 more person needs' : `${missing} more people need`} to join. Share this with them:`;
  $('#invite-link').textContent = link;
  $('#invite-code').textContent = invite.code;
  $('#invite-localhost-note').hidden = !isPrivateNetwork(new URL(link).hostname);
  inviteMessage = 'Hi! Please sign up for our birthday party expense tracker so we can split the costs fairly. 🎂\n\n' +
    `1. Open ${link}\n2. Tap "Sign up"\n3. Use the sign-up code: ${invite.code}`;
}

function renderSummary(s) {
  lastSummary = s;
  const provisional = s.memberCount < s.maxMembers;
  $('#stat-total').textContent = money(s.totalCents);
  // Matches the Share column: some people pay 1¢ more when the total doesn't divide evenly.
  $('#stat-share').textContent = s.shareRemainderCents
    ? `${money(s.perPersonCents)}–${money(s.perPersonCents + 1)}`
    : money(s.perPersonCents);
  $('#stat-share-note').hidden = !provisional;
  $('#stat-share-note').textContent = `Provisional: ${s.memberCount} of ${s.maxMembers} signed up`;
  $('#stat-members').textContent = `${s.memberCount} / ${s.maxMembers}`;
  $('#split-note').textContent = provisional
    ? `Costs are split among the ${s.memberCount} people who have signed up so far. Shares will change as more people join.`
    : `Costs are split equally among all ${s.memberCount} family members.`;

  // People are matched by id; repeated names are numbered ("Mum (1)", "Mum (2)") in table order.
  const personName = id => {
    const m = s.members.find(x => x.id === id);
    const same = s.members.filter(x => x.name.toLowerCase() === m.name.toLowerCase());
    return m.name + (same.length > 1 ? ` (${same.indexOf(m) + 1})` : '') + (id === me.id ? ' (you)' : '');
  };

  $('#members').innerHTML = s.members.map(m => {
    const cls = m.balanceCents > 0 ? 'pos' : m.balanceCents < 0 ? 'neg' : '';
    const label = m.balanceCents > 0 ? `gets back ${money(m.balanceCents)}`
                : m.balanceCents < 0 ? `owes ${money(-m.balanceCents)}` : 'settled';
    return `<tr class="${m.id === me.id ? 'me' : ''}">
      <td>${escapeHtml(personName(m.id))}</td>
      <td class="num">${money(m.paidCents)}</td>
      <td class="num">${money(m.shareCents)}</td>
      <td class="num ${cls}">${label}</td>
    </tr>`;
  }).join('');

  // Settlements carry member ids, so people who share a name are still told apart.
  const isMe = id => id === me.id;
  const name = id => escapeHtml(personName(id));
  const mine = s.settlements.filter(t => isMe(t.fromId) || isMe(t.toId));
  $('#my-settlements').hidden = !s.settlements.length;
  $('#my-settlements').innerHTML = mine.length
    ? '<strong>Your payments:</strong> ' + mine.map(t => isMe(t.fromId)
        ? `You pay ${name(t.toId)} ${money(t.amountCents)}`
        : `${name(t.fromId)} pays you ${money(t.amountCents)}`).join('; ')
    : '<strong>Your payments:</strong> nothing for you to pay or receive.';

  $('#settlements').innerHTML = s.settlements.length
    ? s.settlements.map(t => {
        const from = isMe(t.fromId) ? 'You' : name(t.fromId);
        const pays = isMe(t.fromId) ? 'pay' : 'pays';
        const to = isMe(t.toId) ? 'you' : name(t.toId);
        return `<li class="${isMe(t.fromId) || isMe(t.toId) ? 'mine' : ''}"><strong>${from}</strong> ${pays} <strong>${to}</strong> <span class="amt">${money(t.amountCents)}</span></li>`;
      }).join('')
    : `<li class="muted">${s.totalCents ? 'Everyone is even 🎉' : 'Nothing to settle yet.'}</li>`;
}

let expenseCache = [];

function renderExpenses(expenses) {
  expenseCache = expenses;
  $('#no-expenses').hidden = expenses.length > 0;
  $('#expenses').innerHTML = expenses.map(e => {
    const what = `${escapeHtml(e.description)} (${money(e.amountCents)})`;
    return `
    <tr class="${e.id === editingId ? 'editing' : ''}">
      <td data-label="Date">${formatDate(e.spentOn)}</td>
      <td data-label="Item" class="desc">${escapeHtml(e.description)}</td>
      <td data-label="Paid by">${escapeHtml(e.paidBy)}</td>
      <td data-label="Amount" class="num">${money(e.amountCents)}</td>
      <td class="num actions">${e.memberId === me.id ? `
        <button type="button" class="link" data-edit="${e.id}" aria-label="Edit ${what}">Edit</button>
        <button type="button" class="link danger" data-delete="${e.id}" aria-label="Delete ${what}">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

// ---------- Expense form validation ----------

const FIELD_ERRORS = { description: '#description-error', amount: '#amount-error', spentOn: '#date-error' };

// Mirrors the server: "100", "45.50", "$1,250.00" are fine; at most 2 decimals, above zero.
function amountError(value) {
  const text = value.trim().replace(/^\$/, '');
  if (!text) return 'Enter an amount.';
  // Same rule as the server: commas only as thousands separators, so "1,00" isn't read as 100.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(text)) return 'Use numbers only, with up to 2 decimals — e.g. 45 or 45.50.';
  const cents = Math.round(parseFloat(text.replace(/,/g, '')) * 100);
  if (cents <= 0) return 'The amount must be more than zero.';
  if (cents > 100_000_000) return `The amount must be at most ${money(100_000_000)}.`;
  return '';
}

function dateError(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a valid date.';
  if (value > today()) return 'The date can’t be in the future.';
  return '';
}

function setFieldError(name, message) {
  const input = $('#expense-form').elements[name];
  $(FIELD_ERRORS[name]).textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function clearFieldErrors() {
  for (const name of Object.keys(FIELD_ERRORS)) setFieldError(name, '');
}

// Shows a message beside each bad field and focuses the first one. Returns true when valid.
function validateExpenseForm() {
  const form = $('#expense-form');
  const errors = {
    description: form.description.value.trim() ? '' : 'Say what the expense was for.',
    amount: amountError(form.amount.value),
    spentOn: dateError(form.spentOn.value),
  };
  for (const [name, message] of Object.entries(errors)) setFieldError(name, message);
  const firstBad = Object.keys(errors).find(name => errors[name]);
  if (firstBad) form.elements[firstBad].focus();
  return !firstBad;
}

function resetForm() {
  editingId = null;
  const form = $('#expense-form');
  form.reset();
  form.spentOn.value = today();
  form.spentOn.max = today();
  $('#form-title').textContent = 'Add an expense';
  $('#form-submit').textContent = 'Add expense';
  $('#form-cancel').hidden = true;
  $('#form-error').textContent = '';
  $('#editing-note').hidden = true;
  document.querySelectorAll('#expenses tr.editing').forEach(tr => tr.classList.remove('editing'));
  clearFieldErrors();
}

// ---------- Events ----------

const tabs = [...document.querySelectorAll('.tab')];

function selectTab(tab, { focus = false } = {}) {
  for (const t of tabs) {
    const selected = t === tab;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
  }
  $('#login-form').hidden = tab.dataset.tab !== 'login';
  $('#register-form').hidden = tab.dataset.tab !== 'register';
  $('#auth-error').textContent = '';
  if (focus) tab.focus();
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', e => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length], { focus: true });
  });
});

for (const [formId, endpoint] of [['#login-form', '/api/login'], ['#register-form', '/api/register']]) {
  $(formId).addEventListener('submit', async e => {
    e.preventDefault();
    const button = e.target.querySelector('[type=submit]');
    if (button.disabled) return; // a request is already in flight
    button.disabled = true;
    $('#auth-error').textContent = '';
    try {
      await api(endpoint, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset();
      me = await api('/api/me');
      showApp({ focus: true });
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  me = null;
  showAuth();
});

$('#boot-retry').addEventListener('click', boot);
$('#retry-btn').addEventListener('click', async () => {
  if (await refresh()) announce('Up to date.');
});

$('#copy-invite').addEventListener('click', async () => {
  try {
    await copyText(inviteMessage);
    $('#copy-status').textContent = 'Copied! Paste it into WhatsApp, a text or the family chat.';
  } catch {
    $('#copy-status').textContent = 'Couldn’t copy automatically. Copy the link and code above by hand.';
  }
});

// Re-check a field once the user has moved on from it, and clear its error as they fix it.
$('#exp-amount').addEventListener('blur', e => { if (e.target.value) setFieldError('amount', amountError(e.target.value)); });
$('#exp-date').addEventListener('change', e => setFieldError('spentOn', dateError(e.target.value)));
for (const name of Object.keys(FIELD_ERRORS)) {
  $('#expense-form').elements[name].addEventListener('input', e => {
    if (e.target.getAttribute('aria-invalid')) setFieldError(name, '');
  });
}

$('#expense-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('#form-submit');
  if (button.disabled) return; // a save is already in flight; don't create a duplicate expense
  $('#form-error').textContent = '';
  if (!validateExpenseForm()) return;
  button.disabled = true;
  const body = Object.fromEntries(new FormData(e.target));
  const wasEditing = editingId;
  try {
    if (editingId) await api(`/api/expenses/${editingId}`, { method: 'PUT', body });
    else await api('/api/expenses', { method: 'POST', body });
    resetForm();
    const ok = await refresh();
    $('#exp-description').focus();
    if (ok) announce(`Expense ${wasEditing ? 'updated' : 'added'}. Total is now ${money(lastSummary.totalCents)}.`);
  } catch (err) {
    if (err.status === 401) return showAuth();
    $('#form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#form-cancel').addEventListener('click', () => {
  resetForm();
  $('#exp-description').focus();
});

$('#expenses').addEventListener('click', async e => {
  const button = e.target.closest('button');
  if (!button) return;
  const editId = button.dataset.edit;
  const deleteId = button.dataset.delete;

  if (editId) {
    const exp = expenseCache.find(x => x.id === Number(editId));
    const form = $('#expense-form');
    resetForm();
    editingId = exp.id;
    form.description.value = exp.description;
    form.amount.value = (exp.amountCents / 100).toFixed(2);
    form.spentOn.value = exp.spentOn;
    $('#form-title').textContent = 'Edit expense';
    $('#form-submit').textContent = 'Save changes';
    $('#form-cancel').hidden = false;
    $('#editing-note').textContent = `Editing: ${exp.description} (${money(exp.amountCents)})`;
    $('#editing-note').hidden = false;
    button.closest('tr').classList.add('editing');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.description.focus();
  }

  if (deleteId && !button.disabled) {
    const exp = expenseCache.find(x => x.id === Number(deleteId));
    if (!confirm(`Delete “${exp.description}” (${money(exp.amountCents)}, ${formatDate(exp.spentOn)})?\n\nThis can’t be undone.`)) return;
    $('#expenses-error').textContent = '';
    button.disabled = true; // a delete is in flight
    try {
      await api(`/api/expenses/${deleteId}`, { method: 'DELETE' });
      if (editingId === Number(deleteId)) resetForm();
      const ok = await refresh();
      $('#expenses-heading').focus();
      if (ok) announce(`Deleted “${exp.description}”. Total is now ${money(lastSummary.totalCents)}.`);
    } catch (err) {
      if (err.status === 401) return showAuth();
      $('#expenses-error').textContent = `Couldn’t delete “${exp.description}”. ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }
});

// ---------- Delete account / wipe party data ----------

$('#delete-data-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#delete-data-error').textContent = '';
  const target = e.submitter?.dataset.target || '/api/me';
  const question = target === '/api/party'
    ? 'Delete EVERY member’s account and ALL expenses? Everyone will need to sign up again.'
    : 'Delete your account and all the expenses you added?';
  if (!confirm(question)) return;
  try {
    await api(target, { method: 'DELETE', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    me = null;
    showAuth();
  } catch (err) {
    if (err.status === 401) return showAuth();
    $('#delete-data-error').textContent = err.message;
  }
});

// Only the organiser sees the wipe button. Checked whenever the main view is shown.
new MutationObserver(() => {
  const organiser = Boolean(me?.isOrganiser) && !$('#app-view').hidden;
  $('#wipe-party-btn').hidden = !organiser;
  $('#wipe-party-note').hidden = !organiser;
}).observe($('#app-view'), { attributes: true, attributeFilter: ['hidden'] });

boot();

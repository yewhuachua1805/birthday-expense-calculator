const $ = sel => document.querySelector(sel);
let me = null;
let editingId = null;
let inviteMessage = '';

// ---------- Helpers ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

const money = cents =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const escapeHtml = text =>
  String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

const formatDate = iso =>
  new Date(iso + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const isLocalHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const isPrivateNetwork = host => isLocalHost(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);

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
  try {
    me = await api('/api/me');
    showApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
}

async function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#whoami').textContent = `Hi, ${me.name}`;
  resetForm();
  await refresh();
}

async function refresh() {
  try {
    const [summary, expenses, invite] = await Promise.all([api('/api/summary'), api('/api/expenses'), api('/api/invite')]);
    renderSummary(summary);
    renderInvite(summary, invite);
    renderExpenses(expenses);
  } catch (err) {
    if (err.status === 401) showAuth();
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
  $('#stat-total').textContent = money(s.totalCents);
  // Matches the Share column: some people pay 1¢ more when the total doesn't divide evenly.
  $('#stat-share').textContent = s.shareRemainderCents
    ? `${money(s.perPersonCents)}–${money(s.perPersonCents + 1)}`
    : money(s.perPersonCents);
  $('#stat-members').textContent = `${s.memberCount} / ${s.maxMembers}`;
  $('#split-note').textContent = s.memberCount < s.maxMembers
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

  $('#settlements').innerHTML = s.settlements.length
    ? s.settlements.map(t =>
        `<li><strong>${escapeHtml(personName(t.fromId))}</strong> pays <strong>${escapeHtml(personName(t.toId))}</strong> <span class="amt">${money(t.amountCents)}</span></li>`
      ).join('')
    : `<li class="muted">${s.totalCents ? 'Everyone is even 🎉' : 'Nothing to settle yet.'}</li>`;
}

let expenseCache = [];

function renderExpenses(expenses) {
  expenseCache = expenses;
  $('#no-expenses').hidden = expenses.length > 0;
  $('#expenses').innerHTML = expenses.map(e => `
    <tr>
      <td>${formatDate(e.spentOn)}</td>
      <td class="desc">${escapeHtml(e.description)}</td>
      <td>${escapeHtml(e.paidBy)}</td>
      <td class="num">${money(e.amountCents)}</td>
      <td class="num">${e.memberId === me.id ? `
        <button class="link" data-edit="${e.id}">Edit</button>
        <button class="link danger" data-delete="${e.id}">Delete</button>` : ''}
      </td>
    </tr>`).join('');
}

function resetForm() {
  editingId = null;
  const form = $('#expense-form');
  form.reset();
  form.spentOn.value = today();
  $('#form-title').textContent = 'Add an expense';
  $('#form-submit').textContent = 'Add expense';
  $('#form-cancel').hidden = true;
  $('#form-error').textContent = '';
}

// ---------- Events ----------

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  $('#login-form').hidden = tab.dataset.tab !== 'login';
  $('#register-form').hidden = tab.dataset.tab !== 'register';
  $('#auth-error').textContent = '';
}));

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
      showApp();
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

$('#copy-invite').addEventListener('click', async () => {
  try {
    await copyText(inviteMessage);
    $('#copy-status').textContent = 'Copied! Paste it into WhatsApp, a text or the family chat.';
  } catch {
    $('#copy-status').textContent = 'Couldn’t copy automatically. Copy the link and code above by hand.';
  }
});

$('#expense-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('#form-submit');
  if (button.disabled) return; // a save is already in flight; don't create a duplicate expense
  button.disabled = true;
  $('#form-error').textContent = '';
  const body = Object.fromEntries(new FormData(e.target));
  try {
    if (editingId) await api(`/api/expenses/${editingId}`, { method: 'PUT', body });
    else await api('/api/expenses', { method: 'POST', body });
    resetForm();
    await refresh();
  } catch (err) {
    if (err.status === 401) return showAuth();
    $('#form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#form-cancel').addEventListener('click', resetForm);

$('#expenses').addEventListener('click', async e => {
  const editId = e.target.dataset.edit;
  const deleteId = e.target.dataset.delete;

  if (editId) {
    const exp = expenseCache.find(x => x.id === Number(editId));
    const form = $('#expense-form');
    editingId = exp.id;
    form.description.value = exp.description;
    form.amount.value = (exp.amountCents / 100).toFixed(2);
    form.spentOn.value = exp.spentOn;
    $('#form-title').textContent = 'Edit expense';
    $('#form-submit').textContent = 'Save changes';
    $('#form-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.description.focus();
  }

  if (deleteId && !e.target.disabled && confirm('Delete this expense?')) {
    e.target.disabled = true;
    try {
      await api(`/api/expenses/${deleteId}`, { method: 'DELETE' });
      if (editingId === Number(deleteId)) resetForm();
      await refresh();
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  }
});

boot();

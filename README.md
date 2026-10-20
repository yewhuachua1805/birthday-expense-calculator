# 🎂 Birthday Party Expense Calculator

A small web app for up to 10 family members to record what they spent on the party.
It works out each person's equal share and who needs to pay whom to settle up.

## Run it

Requires Node.js 22.13 or newer. There are no packages to install.

```bash
npm start
```

Then open http://localhost:3000. By default only this computer can connect; see
[Letting family members use it from their phones](#letting-family-members-use-it-from-their-phones).

## Getting everyone signed up

Family members sign up with the app link and a sign-up code. The first time the app starts it generates a
random code, stores it in `party.db` and prints it **once** in the server window. If you missed it, run:

```bash
node server.js --show-code
```

The code must be typed exactly (it's case-sensitive). Wrong codes are rate-limited.

1. Sign up yourself first: open the app, tap **Sign up**, and enter your name, a username, a password
   (at least 8 characters) and the code. The first person to sign up is the **organiser**.
2. The **Get everyone signed up** card shows the link and code. Tap **Copy invite message** and paste it into
   WhatsApp, a text or the family chat. Only share it with family — anyone with the link and code can join.
3. The card shows how many of the 10 have joined, and disappears once everyone has. Sign-up closes at 10 members.

To choose your own code instead, start the app with `SIGNUP_CODE` set (PowerShell):

```powershell
$env:SIGNUP_CODE = "a-long-code-only-family-knows"; npm start
```

## Letting family members use it from their phones

By default the app only listens on `localhost`. To let phones on the same Wi-Fi connect, start it with
`HOST=0.0.0.0` (PowerShell):

```powershell
$env:HOST = "0.0.0.0"; npm start
```

The server window then prints the address to share, e.g. `http://192.168.1.20:3000`.
This is plain HTTP: passwords and the sign-up code cross the Wi-Fi unencrypted, so only do this on a home
network you trust, not on public or shared Wi-Fi.
Windows may ask you to allow Node.js through the firewall; allow it on **Private** networks.
The computer must stay on while people use the app.

If the printed address doesn't work, run `ipconfig`, find your Wi-Fi adapter's **IPv4 Address**, and use
`http://<that address>:3000`.

To use the app from anywhere, deploy it to a host that supports Node and keeps a persistent disk
for `party.db`, such as Render, Railway or Fly.io, and serve it over HTTPS. Set `HOST=0.0.0.0`,
`SIGNUP_CODE`, and `TRUST_PROXY=1` (so the login cookie is marked `Secure` and rate limiting sees real
client addresses behind the host's HTTPS proxy).

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` allows other devices on the network |
| `SIGNUP_CODE` | random, stored in `party.db` | Code family members need to sign up |
| `TRUST_PROXY` | off | Set to `1` behind an HTTPS reverse proxy to trust `X-Forwarded-Proto` / `X-Forwarded-For` |

## How the split works

- Every expense is split equally among **everyone who has signed up**. Until all 10 have joined,
  shares are bigger and will shrink as more people sign up.
- **Balance** = what you paid − your share. Positive means you get money back; negative means you owe.
- **Settle up** lists the fewest payments needed to even everyone out.
- Anyone can see all expenses. You can only edit or delete your own.

## Security

- Passwords must be at least 8 characters and are stored as salted scrypt hashes.
- After 5 wrong passwords for one username, or 20 failed logins from one address, logins are blocked for
  15 minutes. Wrong sign-up codes are limited to 10 per address per 15 minutes.
- Responses carry a Content-Security-Policy and other security headers, and the page can't be framed.

## Your data

`party.db` stores each member's name, username, password hash and login sessions, every expense (description,
amount, date) and the generated sign-up code. Expired sessions are purged automatically.

- Any member can delete their own account under **Your data** at the bottom of the page. This also deletes
  the expenses they added, so the split is recalculated without them.
- The organiser (the first person to sign up) can **Wipe all party data**, which deletes every member and
  expense. Do this, or stop the app and delete `party.db`, once everyone has settled up.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, login/sessions, SQLite database, expense API, split calculator |
| `public/` | The web page (`index.html`, `app.js`, `style.css`) |
| `party.db` | The database, created on first run. Back this file up; delete it to start over. |

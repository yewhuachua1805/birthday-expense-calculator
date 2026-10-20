# 🎂 Birthday Party Expense Calculator

A small web app for up to 10 family members to record what they spent on the party.
It works out each person's equal share and who needs to pay whom to settle up.

## Run it

Requires Node.js 22.13 or newer. There are no packages to install.

```bash
npm start
```

Then open http://localhost:3000. The server window also prints the address family members
on the same Wi-Fi should use, e.g. `http://192.168.1.20:3000`.

## Getting everyone signed up

Family members sign up with the app link and the sign-up code **`birthdayYH`**.
Letter case doesn't matter, so `BirthdayYH` typed on a phone works too.

1. Sign up yourself first: open the app, tap **Sign up**, and enter your name, a username, a password and the code.
2. The **Get everyone signed up** card shows the link and code. Tap **Copy invite message** and paste it into
   WhatsApp, a text or the family chat.
3. The card shows how many of the 10 have joined, and disappears once everyone has. Sign-up closes at 10 members.

To use a different code, start the app with `SIGNUP_CODE` set (PowerShell):

```powershell
$env:SIGNUP_CODE = "newcode"; npm start
```

## Letting family members use it from their phones

Phones on the same Wi-Fi can open the address printed when the app starts.
Windows may ask you to allow Node.js through the firewall; allow it on **Private** networks.
The computer must stay on while people use the app.

If the printed address doesn't work, run `ipconfig`, find your Wi-Fi adapter's **IPv4 Address**, and use
`http://<that address>:3000`.

To use the app from anywhere, deploy it to a host that supports Node and keeps a persistent disk
for `party.db`, such as Render, Railway or Fly.io, and serve it over HTTPS.

## How the split works

- Every expense is split equally among **everyone who has signed up**. Until all 10 have joined,
  shares are bigger and will shrink as more people sign up.
- **Balance** = what you paid − your share. Positive means you get money back; negative means you owe.
- **Settle up** lists the fewest payments needed to even everyone out.
- Anyone can see all expenses. You can only edit or delete your own.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, login/sessions, SQLite database, expense API, split calculator |
| `public/` | The web page (`index.html`, `app.js`, `style.css`) |
| `party.db` | The database, created on first run. Back this file up; delete it to start over. |

# Turkey Chase 9 — multiplayer server

This is the one server that every copy of Turkey Chase 9 (website, Windows, Mac, Android) connects to
when someone presses **🌐 Play Server**. It runs the shared turkeys (first to catch one gets it),
the weather, the chat (with a filter and spam limits) and PvP. It doesn't store anyone's progress itself:
instead it hands each player a **server save code** locked with a secret key only the server has
(`SAVE_KEY`), and opens it again when they come back.

It's a small Node.js app (Node 18 or newer). It needs to be reachable over **https** (so the game can
connect with `wss://`), because the website and the apps all run on secure pages.

## Easiest: Render (free)

1. Put this folder in a GitHub repository (just these files: `server.js`, `species.json`, `package.json`, `README.md`).
2. Go to <https://render.com>, sign in, and choose **New → Web Service**. Pick the repository.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Open **Environment** and add a variable: **Key** `SAVE_KEY`, **Value** the text from the
   `SAVE_KEY.txt` file Claude gave you. This is the secret that locks everyone's server save codes.
   Keep it private (never put it in the GitHub repo), and never change it — if it changes, every old
   server save code stops working. Without it the server runs fine, but server progress isn't saved.
5. Press **Create Web Service**. When it says *Live*, open the address it gives you
   (like `https://your-name.onrender.com`). You should see *"Turkey Chase 9 server is running."*
6. Send that address to Claude, and every version of the game gets rebuilt to connect to it
   (as `wss://your-name.onrender.com`).

On Render's free plan the server goes to sleep after 15 minutes with nobody on it. The next
person to press Play Server waits up to about a minute while it wakes up (the game tells them).
A paid instance stays awake.

## Your own machine (e.g. an Azure VM)

```
npm install
SAVE_KEY=<the text from SAVE_KEY.txt> PORT=8080 npm start
```

Keep it running with something like `pm2` or a systemd service, and put it behind HTTPS
(for example Caddy or nginx with a certificate), forwarding WebSocket traffic to the port.
The game then connects to `wss://your-domain`.

## Checking it

Open the server's address in a browser: it says how many players are online.

## New in the Turkey Chase 9 server

This version adds one tiny thing on top of the Turkey Chase 8 server: it passes **teleport requests**
(`/tpa`, `/tphere`, `/tpaccept`, `/tpdeny`) along to the one player they're meant for. Nothing else changed,
and no player data is stored. **Redeploy this folder** (or push it to your repo) so teleporting works.
